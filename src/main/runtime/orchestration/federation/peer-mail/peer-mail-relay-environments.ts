import type { OrchestrationDb } from '../../db/orchestration-db'
import { listLiveRemoteRunLinkEnvironments } from '../../db/remote-owned/remote-run-links'

/** Servers this Orca opened conversations with, or has a link to that still needs reading or a cancel. */
export function peerMailRelayEnvironments(db: OrchestrationDb): Set<string> {
  return new Set([...db.listHomePeerMailEnvironments(), ...listLiveRemoteRunLinkEnvironments(db)])
}

// Every pull asks about one server only, so closed links' history never enters it: an index seek
// for a home conversation, then one per live link state, stopping at the first row. One equality
// per state, because an IN list builds a temporary set on every call.
const RELAY_WANTS_SQL = `
SELECT 1 FROM peer_mail_conversations WHERE role = 'home' AND environment_id = ?1
UNION ALL
SELECT 1 FROM remote_run_links WHERE environment_id = ?1 AND state = 'open'
UNION ALL
SELECT 1 FROM remote_run_links WHERE environment_id = ?1 AND state = 'cancel_owed'
LIMIT 1`

/** Whether a server's pull loop still has a reason to run; a store read error keeps it running. */
export function peerMailRelayWants(db: OrchestrationDb, environmentId: string): boolean {
  try {
    return db.db.prepare(RELAY_WANTS_SQL).get(environmentId) !== undefined
  } catch {
    return true
  }
}
