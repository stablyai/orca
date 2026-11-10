import type { OrchestrationDb } from '../db/orchestration-db'
import { toSqliteUtcTimestamp } from '../db/utc-timestamp'
import { WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS } from '../db/worker-terminal/worker-terminal-auto-release'

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

export type FederatedHomeAutoReleaseStoreMethods = {
  armFederatedHomeAutoRelease: typeof armFederatedHomeAutoRelease
  endFederatedHomeAutoRelease: typeof endFederatedHomeAutoRelease
  claimDueFederatedHomeAutoReleases: typeof claimDueFederatedHomeAutoReleases
  isFederatedHomeAutoReleaseArmed: typeof isFederatedHomeAutoReleaseArmed
}

export function attachFederatedHomeAutoReleaseStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    armFederatedHomeAutoRelease,
    endFederatedHomeAutoRelease,
    claimDueFederatedHomeAutoReleases,
    isFederatedHomeAutoReleaseArmed
  })
}
