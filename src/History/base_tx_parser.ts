import {
    iHistoryBaseTx,
    iHistoryBaseTxNFTsReceived,
    iHistoryBaseTxNFTsReceivedRaw,
    iHistoryBaseTxNFTsSent,
    iHistoryBaseTxNFTsSentRaw,
    iHistoryBaseTxToken,
    iHistoryBaseTxTokenLossGain,
    iHistoryBaseTxTokenOwners,
    ITransactionData,
    UTXO,
} from '@/History';
import * as Assets from '@/Asset/Assets';
import { bnToLocaleString, getTxFeeX } from '@/utils';
import { AVMConstants } from '@savannah-labs/savannahjs/dist/apis/avm';
import { BN } from '@savannah-labs/savannahjs';
import { getAssetBalanceFromUTXOs, getNFTBalanceFromUTXOs, parseMemo } from '@/History/history_helpers';
import {
    filterDuplicateStrings,
    getAssetOutputs,
    getNotOwnedOutputs,
    getOutputsAssetIDs,
    getOutputsAssetOwners,
    getOutputsOfType,
    getOutputTotals,
    getOwnedOutputs,
} from '@/History/utxo_helpers';
import { getAvaxAssetID } from '@/Network';

export async function getBaseTxSummary(tx: ITransactionData, ownerAddrs: string[]): Promise<iHistoryBaseTx> {
    let ins = tx.inputs?.map((input) => input.output) || [];
    let outs = tx.outputs || [];

    // Calculate losses from inputs
    let losses = getOwnedTokens(ins, ownerAddrs);
    let gains = getOwnedTokens(outs, ownerAddrs);

    let nowOwnedIns = getNotOwnedOutputs(ins, ownerAddrs);
    let nowOwnedOuts = getNotOwnedOutputs(outs, ownerAddrs);

    let froms = getOutputsAssetOwners(nowOwnedIns);
    let tos = getOutputsAssetOwners(nowOwnedOuts);

    let tokens = await getBaseTxTokensSummary(gains, losses, froms, tos);

    return {
        id: tx.id,
        fee: getTxFeeX(),
        type: 'transaction',
        timestamp: new Date(tx.timestamp),
        memo: parseMemo(tx.memo),
        tokens: tokens,
    };
}

function getBaseTxNFTLosses(tx: ITransactionData, ownerAddrs: string[]): iHistoryBaseTxNFTsSentRaw {
    let ins = tx.inputs || [];
    let inUTXOs = ins.map((input) => input.output);
    let nftUTXOs = inUTXOs.filter((utxo) => {
        return utxo.outputType === AVMConstants.NFTXFEROUTPUTID;
    });

    let res: iHistoryBaseTxNFTsSentRaw = {};
    for (let assetID in tx.inputTotals) {
        let nftBal = getNFTBalanceFromUTXOs(nftUTXOs, ownerAddrs, assetID);

        // If empty dictionary pass
        if (Object.keys(nftBal).length === 0) continue;

        res[assetID] = nftBal;
    }
    return res;
}

function getBaseTxNFTGains(tx: ITransactionData, ownerAddrs: string[]): iHistoryBaseTxNFTsReceivedRaw {
    let outs = tx.outputs || [];
    let nftUTXOs = outs.filter((utxo) => {
        return utxo.outputType === AVMConstants.NFTXFEROUTPUTID;
    });
    let res: iHistoryBaseTxNFTsReceivedRaw = {};

    for (let assetID in tx.inputTotals) {
        let nftBal = getNFTBalanceFromUTXOs(nftUTXOs, ownerAddrs, assetID);
        // If empty dictionary pass
        if (Object.keys(nftBal).length === 0) continue;

        res[assetID] = nftBal;
    }
    return res;
}

/**
 * Returns a dictionary of asset totals belonging to the owner
 * @param utxos
 * @param ownerAddrs
 */
function getOwnedTokens(utxos: UTXO[], ownerAddrs: string[]): iHistoryBaseTxTokenLossGain {
    let tokenUTXOs = getOutputsOfType(utxos, AVMConstants.SECPXFEROUTPUTID);
    // Owned inputs
    let myUTXOs = getOwnedOutputs(tokenUTXOs, ownerAddrs);

    // Asset IDs received
    let assetIDs = getOutputsAssetIDs(myUTXOs);

    let res: iHistoryBaseTxTokenLossGain = {};

    for (let i = 0; i < assetIDs.length; i++) {
        let assetID = assetIDs[i];
        let assetUTXOs = getAssetOutputs(myUTXOs, assetID);
        let tot = getOutputTotals(assetUTXOs);
        res[assetID] = tot;
    }

    return res;
}

async function getBaseTxTokensSummary(
    gains: iHistoryBaseTxTokenLossGain,
    losses: iHistoryBaseTxTokenLossGain,
    froms: iHistoryBaseTxTokenOwners,
    tos: iHistoryBaseTxTokenOwners
): Promise<iHistoryBaseTxToken[]> {
    let res: iHistoryBaseTxToken[] = [];

    let assetIDs = filterDuplicateStrings([...Object.keys(gains), ...Object.keys(losses)]);

    // Fetch asset descriptions
    let calls = assetIDs.map((id) => Assets.getAssetDescription(id));
    let descs = await Promise.all(calls);
    let descsDict: any = {};

    // Convert array to dict
    for (let i = 0; i < descs.length; i++) {
        let desc = descs[i];
        descsDict[desc.assetID] = desc;
    }

    for (let i = 0; i < assetIDs.length; i++) {
        let id = assetIDs[i];
        let tokenGain = gains[id] || new BN(0);
        let tokenLost = losses[id] || new BN(0);
        let tokenDesc = descsDict[id];

        // If we sent avax, deduct the fee
        if (id === getAvaxAssetID() && !tokenLost.isZero()) {
            tokenLost = tokenLost.sub(getTxFeeX());
        }

        // How much we gained/lost of this token
        let diff = tokenGain.sub(tokenLost);
        let diffClean = bnToLocaleString(diff, tokenDesc.denomination);

        // If we didnt gain or lose anything, ignore this token
        if (diff.isZero()) continue;

        if (diff.isNeg()) {
            res.push({
                amount: diff,
                amountDisplayValue: diffClean,
                addresses: tos[id],
                asset: tokenDesc,
            });
        } else {
            res.push({
                amount: diff,
                amountDisplayValue: diffClean,
                addresses: froms[id],
                asset: tokenDesc,
            });
        }
    }

    return res;
}
