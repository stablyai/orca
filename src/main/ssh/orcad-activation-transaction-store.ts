import {
  orcadActivationTransactionPath,
  parseOrcadActivationTransaction,
  serializeOrcadActivationTransaction,
  type OrcadActivationTransaction
} from './orcad-activation-transaction'
import {
  readBoundedOrcadRemoteRecord,
  writeAtomicOrcadRemoteRecord
} from './orcad-remote-record-file'
import type { OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import { currentOrcadFence } from './orcad-activation-fence-scope'

const ORCAD_ACTIVATION_TRANSACTION_MAX_BYTES = 64 * 1024

type OrcadActivationTransactionStoreOptions = OrcadRemoteExecTarget & { remoteHome: string }

/** `null` only on a verified absence; an unreadable journal keeps the host fenced. */
export async function readOrcadActivationTransaction(
  options: OrcadActivationTransactionStoreOptions
): Promise<OrcadActivationTransaction | null> {
  const read = await readBoundedOrcadRemoteRecord(
    options,
    orcadActivationTransactionPath(options.host, options.remoteHome),
    ORCAD_ACTIVATION_TRANSACTION_MAX_BYTES
  )
  const parsed = parseOrcadActivationTransaction(read.state === 'present' ? read.raw : null)
  if (parsed.state === 'unreadable') {
    throw new Error(`Cannot read this host's orcad activation transaction: ${parsed.reason}`)
  }
  return parsed.state === 'ok' ? parsed.transaction : null
}

/**
 * Stamped with the writing run's fence token, so a release only ever removes its own generation's
 * journal (Astra pass 9); readers ignore the extra field.
 */
export function writeOrcadActivationTransaction(
  options: OrcadActivationTransactionStoreOptions,
  transaction: OrcadActivationTransaction
): Promise<void> {
  const fenceToken = currentOrcadFence()?.token
  return writeAtomicOrcadRemoteRecord(
    options,
    orcadActivationTransactionPath(options.host, options.remoteHome),
    serializeOrcadActivationTransaction(fenceToken ? { ...transaction, fenceToken } : transaction)
  )
}
