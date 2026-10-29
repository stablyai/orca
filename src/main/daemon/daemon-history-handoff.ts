import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { HISTORY_SEED_TRANSFER_PROTOCOL_VERSION } from './daemon-protocol-version'

export function shouldHandoffDaemonHistory(
  keepHistory: boolean | undefined,
  owner: DaemonPtyAdapter,
  current: DaemonPtyAdapter
): boolean {
  return (
    keepHistory === true &&
    owner !== current &&
    owner.protocolVersion < HISTORY_SEED_TRANSFER_PROTOCOL_VERSION &&
    current.protocolVersion >= HISTORY_SEED_TRANSFER_PROTOCOL_VERSION
  )
}
