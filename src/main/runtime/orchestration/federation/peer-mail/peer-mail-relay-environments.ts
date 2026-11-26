import type { OrchestrationDb } from '../../db/orchestration-db'
import { listLiveRemoteRunLinkEnvironments } from '../../db/remote-owned/remote-run-links'
import { NOT_CLIENT_ENVIRONMENT_SQL } from '../client-asks/client-ask-environment'
import {
  PAIRED_SERVER_ASK_ENVIRONMENTS_SQL,
  PAIRED_SERVER_ASK_WANTS_SQL
} from '../../db/federation/paired-server-asks-store'

/** Servers this Orca opened conversations with, has a link to that still needs reading or a cancel,
 *  or takes its agents' asks from. */
export function peerMailRelayEnvironments(db: OrchestrationDb): Set<string> {
  return new Set([
    ...db.listHomePeerMailEnvironments(),
    ...listLiveRemoteRunLinkEnvironments(db),
    ...db.db
      .prepare(PAIRED_SERVER_ASK_ENVIRONMENTS_SQL)
      .all()
      .map((row) => String(row.environment_id))
  ])
}

// Every pull asks about one server only, so closed links' history never enters it: an index seek
// for a home conversation, then one per live link state, stopping at the first row. One equality
// per state, because an IN list builds a temporary set on every call.
const RELAY_WANTS_SQL = `
SELECT 1 FROM peer_mail_conversations WHERE role = 'home' AND environment_id = ?1 AND ${NOT_CLIENT_ENVIRONMENT_SQL}
UNION ALL
SELECT 1 FROM remote_run_links WHERE environment_id = ?1 AND state = 'open'
UNION ALL
SELECT 1 FROM remote_run_links WHERE environment_id = ?1 AND state = 'cancel_owed'
UNION ALL
${PAIRED_SERVER_ASK_WANTS_SQL}
LIMIT 1`

/** Whether a server's pull loop still has a reason to run; a store read error keeps it running. */
export function peerMailRelayWants(db: OrchestrationDb, environmentId: string): boolean {
  try {
    return db.db.prepare(RELAY_WANTS_SQL).get(environmentId) !== undefined
  } catch {
    return true
  }
}
