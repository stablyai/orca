import type { SshConnection } from './ssh-connection'
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
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

const ORCAD_ACTIVATION_TRANSACTION_MAX_BYTES = 64 * 1024

type OrcadActivationTransactionStoreOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  signal?: AbortSignal
}

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

export async function readOrcadActivationTransaction(
  options: OrcadActivationTransactionStoreOptions
): Promise<OrcadActivationTransaction | null> {
  const raw = await readBoundedOrcadRemoteRecord(
    options,
    orcadActivationTransactionPath(options.host, options.remoteHome),
    ORCAD_ACTIVATION_TRANSACTION_MAX_BYTES
  )
  const parsed = parseOrcadActivationTransaction(raw)
  if (parsed.state === 'ok') {
    return parsed.transaction
  }
  if (parsed.state === 'unreadable') {
    throw new Error(`Cannot read this host's orcad activation transaction: ${parsed.reason}`)
  }
  return null
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
