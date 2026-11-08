import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import type { DispatchContextRow } from '../orchestration-records'

export type WorkerTerminalClaim = {
  handle: string
  paneKey?: string
  /** A racing follow-up of the same settled Dispatch is left to `follow_up_claimed`, which steers the send into it. */
  followUpOf?: string
}

// A starting Dispatch names its terminal only in its start options until its authority attaches.
const STARTING_ON_TERMINAL_SQL = `SELECT d.* FROM dispatch_contexts d
  JOIN worker_dispatches w ON w.dispatch_id = d.id
  WHERE d.status = 'pending' AND w.state = 'starting'
    AND json_extract(w.start_options, '$.terminal') = ?
  ORDER BY d.rowid LIMIT 1`

/** Refuse a worker-start or follow-up onto a terminal another open Dispatch holds or is starting on.
 *  worker-start and the follow-up a send starts both claim through here, so whichever comes second is refused before any wait. */
export function refuseClaimedWorkerTerminal(db: OrchestrationDb, claim: WorkerTerminalClaim): void {
  const open =
    db.findActiveDispatchForAssignee(claim.handle, claim.paneKey) ??
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selects whole dispatch_contexts rows.
    (db.db.prepare(STARTING_ON_TERMINAL_SQL).get(claim.handle) as DispatchContextRow | undefined)
  if (open && !(claim.followUpOf && open.follow_up_of_dispatch_id === claim.followUpOf)) {
    throw terminalBusyError(db, claim.handle, open)
  }
}

function terminalBusyError(
  db: OrchestrationDb,
  handle: string,
  open: DispatchContextRow
): OrchestrationError {
  const task = db.getTask(open.task_id)
  const title = task?.task_title ?? task?.spec.split('\n')[0]?.slice(0, 80)
  const followUp = open.follow_up_of_dispatch_id
    ? `, the follow-up of Dispatch ${open.follow_up_of_dispatch_id}`
    : ''
  return new OrchestrationError(
    'terminal_busy',
    `Terminal ${handle} is busy: Dispatch ${open.id}${followUp} (task ${open.task_id}${title ? ` "${title}"` : ''}) is still open on it. To answer it or give it more work, use your Orca CLI's \`orchestration send --to dispatch:${open.id}\`; to replace it, run \`orchestration worker-stop --dispatch ${open.id}\` and then start again. No effects were applied.`,
    { effectsApplied: false, dispatchId: open.id, taskId: open.task_id }
  )
}
