/** Pin every journaled slot needed for recovery. An unreadable journal or unjournaled held fence hides transaction state, so GC must retain everything. */
import { orcadInstallDirNames } from './orcad-activation-record'
import type { OrcadActivationTransaction } from './orcad-activation-transaction'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { orcadActivationFenceExists } from './orcad-activation-lock'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import type { OrcadRemoteExecTarget } from '../install/orcad-remote-runtime-control'

type OrcadGcTransactionPins = { state: 'pinned'; dirNames: string[] } | { state: 'keep-all' }

function transactionVersions(transaction: OrcadActivationTransaction): (string | null)[] {
  const records = [transaction.recordBefore, transaction.recordAfter]
  const fromRecords = records.flatMap((record) => (record ? [record.active, record.previous] : []))
  if (transaction.operation === 'activate') {
    return [...fromRecords, transaction.candidateVersion]
  }
  return transaction.operation === 'rollback'
    ? [...fromRecords, transaction.incumbentVersion, transaction.targetVersion]
    : fromRecords
}

export async function readOrcadGcTransactionPins(
  target: OrcadRemoteExecTarget & { remoteHome: string },
  /** The caller holds the activation fence, so its presence says nothing about another owner. */
  options: { callerHoldsFence?: boolean } = {}
): Promise<OrcadGcTransactionPins> {
  try {
    const transaction = await readOrcadActivationTransaction(target)
    if (!transaction) {
      // An unjournaled fence may be a transaction starting or an interrupted release.
      return !options.callerHoldsFence && (await orcadActivationFenceExists(target))
        ? { state: 'keep-all' }
        : { state: 'pinned', dirNames: [] }
    }
    return { state: 'pinned', dirNames: orcadInstallDirNames(transactionVersions(transaction)) }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return { state: 'keep-all' }
  }
}
