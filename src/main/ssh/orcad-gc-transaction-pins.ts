/**
 * What an in-flight activation, rollback or decommission still needs from GC.
 *
 * The journal names every slot the transaction may restart or settle; GC must keep them all.
 * A held fence without a journal, or a journal this client cannot read, means a transaction
 * this client cannot see into, so GC keeps everything rather than guess.
 */
import { remoteInstallDirName, ORCAD_INSTALL_MODEL } from './remote-install-model'
import type { OrcadActivationTransaction } from './orcad-activation-transaction'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { orcadActivationFenceExists } from './orcad-activation-lock'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import type { OrcadRemoteExecTarget } from './orcad-remote-runtime-control'

export type OrcadGcTransactionPins = { state: 'pinned'; dirNames: string[] } | { state: 'keep-all' }

function transactionVersions(transaction: OrcadActivationTransaction): (string | null)[] {
  const records = [transaction.recordBefore, transaction.recordAfter]
  const fromRecords = records.flatMap((record) => (record ? [record.active, record.previous] : []))
  if (transaction.operation === 'activate') {
    return [...fromRecords, transaction.candidateVersion]
  }
  // Any other operation names its slots through its records.
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
      // A fence without a journal is a transaction starting or a release cut short.
      return (await orcadActivationFenceExists(target))
        ? { state: 'keep-all' }
        : { state: 'pinned', dirNames: [] }
    }
    const versions = transactionVersions(transaction).filter(
      (version): version is string => typeof version === 'string' && version.length > 0
    )
    return {
      state: 'pinned',
      dirNames: [...new Set(versions)].map((version) =>
        remoteInstallDirName(ORCAD_INSTALL_MODEL, version)
      )
    }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return { state: 'keep-all' }
  }
}
