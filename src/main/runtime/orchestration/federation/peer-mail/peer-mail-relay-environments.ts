import type { OrchestrationDb } from '../../db/orchestration-db'
import { listLiveRemoteRunLinkEnvironments } from '../../db/remote-owned/remote-run-links'

/** Servers this Orca opened conversations with, or has a link to that still needs reading or a cancel. */
export function peerMailRelayEnvironments(db: OrchestrationDb): Set<string> {
  return new Set([...db.listHomePeerMailEnvironments(), ...listLiveRemoteRunLinkEnvironments(db)])
}

/** Whether a server's pull loop still has a reason to run; a store read error keeps it running. Runs
 *  every pull, so it asks about this one server only: closed links' history never enters it. */
export function peerMailRelayWants(db: OrchestrationDb, environmentId: string): boolean {
  try {
    return db.hasHomePeerMailEnvironment(environmentId) || hasLiveRemoteRunLink(db, environmentId)
  } catch {
    return true
  }
}

/** A seek on this server's own (environment_id, state) index rows, however many closed links it keeps. */
function hasLiveRemoteRunLink(db: OrchestrationDb, environmentId: string): boolean {
  return (
    db.db
      .prepare(
        `SELECT 1 FROM remote_run_links
         WHERE environment_id = ? AND state IN ('open', 'cancel_owed') LIMIT 1`
      )
      .get(environmentId) !== undefined
  )
}
