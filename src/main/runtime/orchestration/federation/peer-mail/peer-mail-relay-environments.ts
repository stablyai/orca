import type { OrchestrationDb } from '../../db/orchestration-db'
import { listLiveRemoteRunLinkEnvironments } from '../../db/remote-owned/remote-run-links'

/** Servers this Orca opened conversations with, or has a link to that still needs reading or a cancel. */
export function peerMailRelayEnvironments(db: OrchestrationDb): Set<string> {
  return new Set([...db.listHomePeerMailEnvironments(), ...listLiveRemoteRunLinkEnvironments(db)])
}

/** Whether a server's pull loop still has a reason to run; a store read error keeps it running. */
export function peerMailRelayWants(db: OrchestrationDb, environmentId: string): boolean {
  try {
    return peerMailRelayEnvironments(db).has(environmentId)
  } catch {
    return true
  }
}
