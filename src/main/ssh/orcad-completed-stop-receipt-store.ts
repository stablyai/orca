import {
  parseOrcadCompletedStopReceipt,
  ORCAD_COMPLETED_STOP_RECEIPT_FILENAME
} from './orcad-completed-stop-receipt'
import { readBoundedOrcadRemoteRecord } from './orcad-remote-record-file'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  parseOrcadActivationTransaction,
  serializeOrcadActivationTransaction,
  type OrcadDecommissionTransaction,
  type OrcadActivationTransaction
} from './orcad-activation-transaction'

export async function readRemoteOrcadCompletedStopReceipt(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  signal?: AbortSignal
}): Promise<OrcadDecommissionTransaction | null> {
  const path = joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    ORCAD_COMPLETED_STOP_RECEIPT_FILENAME
  )
  const parsed = parseOrcadCompletedStopReceipt(
    await readBoundedOrcadRemoteRecord(options, path, 64 * 1024)
  )
  if (parsed.state === 'absent') {
    return null
  }
  if (parsed.state === 'unreadable') {
    throw new Error(`Managed-stop completion receipt is unreadable: ${parsed.reason}`)
  }
  return parsed.transaction
}

export function sameOrcadCompletedStopReceipt(
  receipt: OrcadDecommissionTransaction,
  original: OrcadDecommissionTransaction
): boolean {
  return sameExactOrcadStopTransaction(
    { ...receipt, phase: original.phase, updatedAt: original.updatedAt },
    original
  )
}

export function sameExactOrcadStopTransaction(
  left: OrcadActivationTransaction,
  right: OrcadActivationTransaction
): boolean {
  const a = parseOrcadActivationTransaction(serializeOrcadActivationTransaction(left))
  const b = parseOrcadActivationTransaction(serializeOrcadActivationTransaction(right))
  return (
    a.state === 'ok' &&
    b.state === 'ok' &&
    serializeOrcadActivationTransaction(a.transaction) ===
      serializeOrcadActivationTransaction(b.transaction)
  )
}
