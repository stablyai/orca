import {
  orcadActivationTransactionPath,
  parseOrcadActivationTransaction,
  serializeOrcadActivationTransaction,
  type OrcadActivationTransaction
} from './orcad-activation-transaction'
import {
  readBoundedOrcadRemoteRecord,
  writeAtomicOrcadRemoteRecord
} from '../install/orcad-remote-record-file'
import type { OrcadRemoteExecTarget } from '../install/orcad-remote-runtime-control'
import { currentOrcadFence } from './orcad-activation-fence-scope'

const ORCAD_ACTIVATION_TRANSACTION_MAX_BYTES = 64 * 1024

type OrcadActivationTransactionStoreOptions = OrcadRemoteExecTarget & { remoteHome: string }

/** Only verified absence returns null; unreadable journals retain the fence. */
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

/** Stamp each write with its fence generation so release cannot delete another holder's journal. */
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
