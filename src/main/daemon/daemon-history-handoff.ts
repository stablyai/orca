import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { HISTORY_SEED_TRANSFER_PROTOCOL_VERSION } from './daemon-protocol-version'

// Why: the version gate is the reusable primitive. shouldHandoffDaemonHistory below
// layers an explicit `keepHistory` request on top of it for the session-close path;
// the generation retirement scheduler (daemon-generation-retirement.ts) calls this
// directly, since a proactive handoff has no `keepHistory` flag from a caller -- only
// the discovered legacy generation and the busy/idle read that already gate it.
export function canHandoffDaemonHistory(
  owner: DaemonPtyAdapter,
  current: DaemonPtyAdapter
): boolean {
  return (
    owner !== current &&
    owner.protocolVersion < HISTORY_SEED_TRANSFER_PROTOCOL_VERSION &&
    current.protocolVersion >= HISTORY_SEED_TRANSFER_PROTOCOL_VERSION
  )
}

export function shouldHandoffDaemonHistory(
  keepHistory: boolean | undefined,
  owner: DaemonPtyAdapter,
  current: DaemonPtyAdapter
): boolean {
  return keepHistory === true && canHandoffDaemonHistory(owner, current)
}
