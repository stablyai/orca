import {
  ORCAD_ACTIVATION_TRANSACTION_FILENAME,
  parseOrcadActivationTransaction,
  serializeOrcadActivationTransaction,
  type OrcadActivationTransaction
} from './orcad-activation-transaction'
import { orcadActivationTransactionRoot } from './orcad-activation-lock'
import {
  readBoundedOrcadRemoteRecord,
  writeAtomicOrcadRemoteRecord
} from './orcad-remote-record-file'
import type { OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

const ORCAD_ACTIVATION_TRANSACTION_MAX_BYTES = 64 * 1024

type OrcadActivationTransactionStoreOptions = OrcadRemoteExecTarget & { remoteHome: string }

export function orcadActivationTransactionPath(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return joinRemotePath(
    host,
    orcadActivationTransactionRoot(host, remoteHome),
    ORCAD_ACTIVATION_TRANSACTION_FILENAME
  )
}

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

export function writeOrcadActivationTransaction(
  options: OrcadActivationTransactionStoreOptions,
  transaction: OrcadActivationTransaction
): Promise<void> {
  return writeAtomicOrcadRemoteRecord(
    options,
    orcadActivationTransactionPath(options.host, options.remoteHome),
    serializeOrcadActivationTransaction(transaction)
  )
}
