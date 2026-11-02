import {
  liveWorkerTerminalAutoReleaseAt,
  type WorkerTerminalResourceRow,
  WORKER_RELEASABLE_STATES,
  WORKER_TERMINAL_AUTO_RELEASE_LIVE_SQL
} from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'
import { exposeUtcTimestamp, toSqliteUtcTimestamp } from '../utc-timestamp'

export const WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS = 2 * 60_000

const RELEASABLE_STATES_SQL = WORKER_RELEASABLE_STATES.map((state) => `'${state}'`).join(', ')

// The owner Dispatch, local or a paired host's attachment, finished in a state Orca may close.
export const OWNER_RELEASABLE_SQL = `(
  EXISTS (
    SELECT 1 FROM worker_dispatches w
     WHERE w.dispatch_id = worker_terminal_resources.owner_dispatch_id
       AND w.state IN (${RELEASABLE_STATES_SQL})
  )
  OR EXISTS (
    SELECT 1 FROM remote_dispatch_attachments a
     WHERE a.dispatch_id = worker_terminal_resources.owner_dispatch_id
       AND a.state IN (${RELEASABLE_STATES_SQL})
  )
)`

// Armed for its owner and not yet kept, retained or released.
const ARMED_SQL = `auto_release_dispatch_id = owner_dispatch_id AND ownership_state = 'owned'
  AND release_state = 'not_requested'`

/** Arm once per owning Dispatch inside its settlement transaction; a repeat report never extends it. */
export function armWorkerTerminalAutoReleaseStatement(
  this: OrchestrationDb,
  dispatchId: string,
  nowMs = Date.now()
): void {
  const { changes } = this.db
    .prepare(
      `UPDATE worker_terminal_resources
          SET auto_release_at = ?, auto_release_dispatch_id = owner_dispatch_id,
              updated_at = datetime('now')
        WHERE owner_dispatch_id = ? AND ownership_state = 'owned'
          AND release_state = 'not_requested'
          AND auto_release_dispatch_id IS NOT owner_dispatch_id`
    )
    .run(toSqliteUtcTimestamp(nowMs + WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS), dispatchId)
  if (changes > 0) {
    this.workerTerminalAutoReleaseListener?.()
  }
}

/** The agent works again: its countdown waits until it next rests. A claimed close is final. */
export function suspendWorkerTerminalAutoRelease(this: OrchestrationDb, paneKey: string): void {
  const { changes } = this.db
    .prepare(
      `UPDATE worker_terminal_resources SET auto_release_at = NULL, updated_at = datetime('now')
        WHERE pane_key = ? AND ${ARMED_SQL} AND auto_release_at IS NOT NULL`
    )
    .run(paneKey)
  if (changes > 0) {
    this.workerTerminalAutoReleaseListener?.()
  }
}

/** The agent rests again: a suspended countdown starts over. */
export function restartWorkerTerminalAutoRelease(
  this: OrchestrationDb,
  paneKey: string,
  nowMs = Date.now()
): void {
  const { changes } = this.db
    .prepare(
      `UPDATE worker_terminal_resources SET auto_release_at = ?, updated_at = datetime('now')
        WHERE pane_key = ? AND ${ARMED_SQL} AND auto_release_at IS NULL`
    )
    .run(toSqliteUtcTimestamp(nowMs + WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS), paneKey)
  if (changes > 0) {
    this.workerTerminalAutoReleaseListener?.()
  }
}

/** The automatic counterpart of a release request: it never overrides retention, keep or transfer.
 *  An agent in a turn when its deadline comes is suspended instead of claimed.
 *  The kept deadline marks the request automatic until an explicit request clears it. */
export function claimDueWorkerTerminalAutoReleases(
  this: OrchestrationDb,
  nowMs: number,
  inTurn: (resource: WorkerTerminalResourceRow) => boolean = () => false
): number {
  if (this.workerAutoReleaseEnabled?.() === false) {
    return 0
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table yields its row type.
  const due = this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE ${WORKER_TERMINAL_AUTO_RELEASE_LIVE_SQL} AND auto_release_at <= ?
          AND ${OWNER_RELEASABLE_SQL}`
    )
    .all(toSqliteUtcTimestamp(nowMs)) as WorkerTerminalResourceRow[]
  let claimed = 0
  for (const resource of due) {
    if (inTurn(resource)) {
      if (resource.pane_key) {
        this.suspendWorkerTerminalAutoRelease(resource.pane_key)
      }
      continue
    }
    claimed += Number(
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
            SET release_state = 'requested', retained_reason = NULL,
                release_requested_at = datetime('now'), release_error = NULL,
                updated_at = datetime('now')
          WHERE id = ? AND ${WORKER_TERMINAL_AUTO_RELEASE_LIVE_SQL} AND auto_release_at <= ?`
        )
        .run(resource.id, toSqliteUtcTimestamp(nowMs)).changes
    )
  }
  return claimed
}

/** A claimed close found its agent working again: back to suspended, output archive dropped. */
export function deferWorkerTerminalAutoRelease(this: OrchestrationDb, resourceId: string): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(resourceId)
    const { changes } = this.db
      .prepare(
        `UPDATE worker_terminal_resources
            SET release_state = 'not_requested', auto_release_at = NULL, archive_source = NULL,
                archive_status = NULL, release_requested_at = NULL, updated_at = datetime('now')
          WHERE id = ? AND ownership_state = 'owned' AND release_state IN ('requested', 'releasing')
            AND auto_release_at IS NOT NULL AND auto_release_dispatch_id = owner_dispatch_id`
      )
      .run(resourceId)
    if (changes > 0 && resource) {
      this.db
        .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
        .run(resource.owner_dispatch_id)
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** The automatic chat close's last word, run in the session lane right before Stop: clearing the
 *  deadline ends Keep open's chance to cancel it. A turn begun meanwhile calls it off; judged from the
 *  current row, so an explicit release that joined it passes. */
export function admitWorkerChatReleaseClose(
  this: OrchestrationDb,
  resourceId: string,
  inTurn: (resource: WorkerTerminalResourceRow) => boolean
): boolean {
  const current = this.getWorkerTerminalResource(resourceId)
  if (
    current?.auto_release_at &&
    current.auto_release_dispatch_id === current.owner_dispatch_id &&
    inTurn(current)
  ) {
    this.deferWorkerTerminalAutoRelease(resourceId)
    return false
  }
  const { changes } = this.db
    .prepare(
      `UPDATE worker_terminal_resources SET auto_release_at = NULL, updated_at = datetime('now')
        WHERE id = ? AND ownership_state = 'owned' AND release_state = 'releasing'`
    )
    .run(resourceId)
  return changes > 0
}

/** Only for a host that cannot release on its own; arms once, so a retain or release before settlement still wins. */
export function armFederatedHomeAutoRelease(
  this: OrchestrationDb,
  dispatchId: string,
  nowMs = Date.now()
): void {
  const { changes } = this.db
    .prepare(
      `UPDATE federated_dispatches
          SET home_auto_release_at = ?, home_auto_release_state = 'armed', updated_at = datetime('now')
        WHERE dispatch_id = ? AND home_auto_release_state IS NULL`
    )
    .run(toSqliteUtcTimestamp(nowMs + WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS), dispatchId)
  if (changes > 0) {
    this.workerTerminalAutoReleaseListener?.()
  }
}

/** A retain, an explicit release or the host's answer to an attempt ends the home deadline for good. */
export function endFederatedHomeAutoRelease(this: OrchestrationDb, dispatchId: string): void {
  this.db
    .prepare(
      `UPDATE federated_dispatches
          SET home_auto_release_at = NULL, home_auto_release_state = 'ended', updated_at = datetime('now')
        WHERE dispatch_id = ? AND home_auto_release_state IS NOT 'ended'`
    )
    .run(dispatchId)
}

/** Claiming postpones the deadline instead of hiding it, so an attempt cut short by a crash or failure runs again. */
export function claimDueFederatedHomeAutoReleases(this: OrchestrationDb, nowMs: number): string[] {
  if (this.workerAutoReleaseEnabled?.() === false) {
    return []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly this one column.
  const due = this.db
    .prepare(
      `SELECT dispatch_id FROM federated_dispatches
        WHERE home_auto_release_state = 'armed' AND home_auto_release_at <= ?`
    )
    .all(toSqliteUtcTimestamp(nowMs)) as { dispatch_id: string }[]
  const claim = this.db.prepare(
    `UPDATE federated_dispatches
        SET home_auto_release_at = ?, updated_at = datetime('now')
      WHERE dispatch_id = ? AND home_auto_release_state = 'armed' AND home_auto_release_at <= ?`
  )
  const retryAt = toSqliteUtcTimestamp(nowMs + WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS)
  return due.flatMap(({ dispatch_id }) =>
    claim.run(retryAt, dispatch_id, toSqliteUtcTimestamp(nowMs)).changes > 0 ? [dispatch_id] : []
  )
}

export function isFederatedHomeAutoReleaseArmed(
  this: OrchestrationDb,
  dispatchId: string
): boolean {
  return (
    this.db
      .prepare(
        `SELECT 1 FROM federated_dispatches
          WHERE dispatch_id = ? AND home_auto_release_state = 'armed'`
      )
      .get(dispatchId) !== undefined
  )
}

export function nextWorkerTerminalAutoReleaseAtMs(this: OrchestrationDb): number | null {
  // Off: nothing is due, so no timer runs until the setting turns back on.
  if (this.workerAutoReleaseEnabled?.() === false) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an aggregate SELECT always returns exactly this one-column row.
  const row = this.db
    .prepare(
      `SELECT MIN(at) AS at FROM (
         SELECT MIN(auto_release_at) AS at FROM worker_terminal_resources
          WHERE ${WORKER_TERMINAL_AUTO_RELEASE_LIVE_SQL}
         UNION ALL
         SELECT MIN(home_auto_release_at) FROM federated_dispatches
          WHERE home_auto_release_state = 'armed' AND home_auto_release_at IS NOT NULL
       )`
    )
    .get() as { at: string | null }
  return row.at ? Date.parse(exposeUtcTimestamp(row.at) ?? row.at) : null
}

export function getLiveWorkerTerminalAutoReleaseAt(
  this: OrchestrationDb,
  dispatchId: string
): string | null {
  return liveWorkerTerminalAutoReleaseAt(this.getWorkerTerminalResourceByOwner(dispatchId))
}

export type WorkerTerminalAutoReleaseMethods = {
  getLiveWorkerTerminalAutoReleaseAt: typeof getLiveWorkerTerminalAutoReleaseAt
  armWorkerTerminalAutoReleaseStatement: typeof armWorkerTerminalAutoReleaseStatement
  suspendWorkerTerminalAutoRelease: typeof suspendWorkerTerminalAutoRelease
  restartWorkerTerminalAutoRelease: typeof restartWorkerTerminalAutoRelease
  deferWorkerTerminalAutoRelease: typeof deferWorkerTerminalAutoRelease
  claimDueWorkerTerminalAutoReleases: typeof claimDueWorkerTerminalAutoReleases
  admitWorkerChatReleaseClose: typeof admitWorkerChatReleaseClose
  nextWorkerTerminalAutoReleaseAtMs: typeof nextWorkerTerminalAutoReleaseAtMs
  armFederatedHomeAutoRelease: typeof armFederatedHomeAutoRelease
  endFederatedHomeAutoRelease: typeof endFederatedHomeAutoRelease
  claimDueFederatedHomeAutoReleases: typeof claimDueFederatedHomeAutoReleases
  isFederatedHomeAutoReleaseArmed: typeof isFederatedHomeAutoReleaseArmed
}

export function attachWorkerTerminalAutoRelease(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getLiveWorkerTerminalAutoReleaseAt,
    armWorkerTerminalAutoReleaseStatement,
    suspendWorkerTerminalAutoRelease,
    restartWorkerTerminalAutoRelease,
    deferWorkerTerminalAutoRelease,
    claimDueWorkerTerminalAutoReleases,
    admitWorkerChatReleaseClose,
    nextWorkerTerminalAutoReleaseAtMs,
    armFederatedHomeAutoRelease,
    endFederatedHomeAutoRelease,
    claimDueFederatedHomeAutoReleases,
    isFederatedHomeAutoReleaseArmed
  })
}
