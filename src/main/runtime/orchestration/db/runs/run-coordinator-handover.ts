// A chat that will never read again hands its Runs to the chat that reads its mail now, so their
// workers' later reports and asks reach someone instead of waiting on a closed chat.
import {
  formatOrcaSessionAddress,
  type OrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'

/** Unread Run mail an earlier coordinator was pointed at is pointed at again, for whoever reads the
 *  Run now. Cards still in a chat move by their own custody. */
export function repointUnreadRunMail(db: OrchestrationDb, runId: string): void {
  db.db
    .prepare(
      `UPDATE messages
       SET delivered_at = NULL, pointer_pty_id = NULL, pointer_process_incarnation = NULL
       WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
         AND delivered_at IS NOT NULL AND pointer_enter_pending = 0
         AND id NOT IN (SELECT message_id FROM structured_mail_sends WHERE mailbox_handle = ?)`
    )
    .run(`run:${runId}`, `run:${runId}`)
}

/** Every Run `from` coordinates now coordinated from `to`, keeping `to`'s own Runs; true when any moved. */
export function handOverCoordinatorChatRuns(
  db: OrchestrationDb,
  from: OrcaSessionId,
  to: OrcaSessionId
): boolean {
  const runs = db.runsBoundToCoordinator({
    orcaSessionId: from,
    paneKey: null,
    terminalHandle: null
  })
  if (runs.length === 0 || from === to) {
    return false
  }
  const changed = new Set<string>([formatOrcaSessionAddress(to)])
  runLifecycleWriteTransaction(db.db, 'hand_over_coordinator_runs', () => {
    for (const run of runs) {
      const mailbox = `run:${run.id}`
      db.routeAllUnreadDirectMessagesToRunMailbox(run.id, formatOrcaSessionAddress(from))
      db.db
        .prepare(
          `UPDATE runs
           SET coordinator_handle = NULL, coordinator_pane_key = NULL, coordinator_orca_session_id = ?,
               coordinator_orca_session_id_generation = consumer_generation + 1,
               consumer_generation = consumer_generation + 1,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(to, run.id)
      db.fenceUnacknowledgedMailboxDeliveries(mailbox)
      repointUnreadRunMail(db, run.id)
      changed.add(mailbox)
    }
  })
  db.crewChanges.notify(
    Object.assign(new Set(['topology'] as const), { trafficAddresses: changed })
  )
  return true
}
