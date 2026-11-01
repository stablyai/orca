/** Pin every journaled slot needed for recovery. An unreadable journal or unjournaled held fence hides transaction state, so GC must retain everything. */
import { orcadInstallDirNames } from '../managed-server/activation/orcad-activation-record'
import type { OrcadActivationTransaction } from '../managed-server/activation/orcad-activation-transaction'
import { readOrcadActivationTransaction } from '../managed-server/activation/orcad-activation-transaction-store'
import { orcadActivationFenceExists } from '../managed-server/activation/orcad-activation-lock'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'
import type { OrcadRemoteExecTarget } from '../managed-server/install/orcad-remote-runtime-control'

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
  target: OrcadRemoteExecTarget & { remoteHome: string }
): Promise<OrcadGcTransactionPins> {
  try {
    const transaction = await readOrcadActivationTransaction(target)
    if (!transaction) {
      // An unjournaled fence may be a transaction starting or an interrupted release.
      return (await orcadActivationFenceExists(target))
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
