import { ensureControlPlaneTables, type ControlPlaneDatabaseHandle } from './control-plane-store'
import type { OutcomePhaseKind } from './outcome-policy'
import type { RouteIdentity } from './route-registry-types'

/** B7 (correction 3) — the durable launch record for one planned phase.
 *
 *  Loop edges, all persisted here:
 *
 *    trigger                          immediate state  writer          next state
 *    ----------------------------------------------------------------------------
 *    phase created by the lifecycle   pending          recordPlanned   starting
 *    driver claims the launch         starting         claimForStart   started | start_unknown | failed
 *    worker-start returned a Dispatch started          markStarted     terminal
 *    worker-start response was lost   start_unknown    markUnknown     started (reconciled) | failed
 *    no certified route for the role  blocked          markBlocked     terminal
 *    attempts exhausted               failed           markFailed      terminal
 *
 *  Authoritative event/clock: the runtime's, passed in as `nowMs`. Idempotency
 *  key: `phase_id`, with a UNIQUE index on `task_id` so a replayed plan can
 *  never fork a second launch for the same Task. Re-arm: `pending` and
 *  `start_unknown` and `blocked` are the states the driver picks up again.
 *  Terminal resolver: `started` and `failed`.
 *
 *  `claimForStart` is a conditional UPDATE, so two concurrent drivers cannot
 *  both claim one phase — the loser sees zero rows changed and skips.
 */

export type PhaseLaunchState =
  | 'pending'
  | 'starting'
  | 'started'
  | 'start_unknown'
  | 'blocked'
  | 'failed'

export type PhaseLaunchRow = {
  phase_id: string
  run_id: string
  outcome_id: string
  task_id: string
  kind: Exclude<OutcomePhaseKind, 'build'>
  state: PhaseLaunchState
  agent: string | null
  model: string | null
  reasoning: string | null
  terminal_handle: string | null
  worktree_id: string | null
  bound_sha: string
  dispatch_id: string | null
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

/** How many times the driver will re-attempt a launch before failing closed. */
export const PHASE_LAUNCH_MAX_ATTEMPTS = 3

export class PhaseLaunchStore {
  private readonly handle: ControlPlaneDatabaseHandle

  constructor(handle: ControlPlaneDatabaseHandle) {
    this.handle = handle
    ensureControlPlaneTables(handle)
  }

  get(phaseId: string): PhaseLaunchRow | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_phase_launches WHERE phase_id = ?')
      .get(phaseId) as PhaseLaunchRow | undefined
  }

  getByTask(taskId: string): PhaseLaunchRow | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_phase_launches WHERE task_id = ?')
      .get(taskId) as PhaseLaunchRow | undefined
  }

  list(runId: string): PhaseLaunchRow[] {
    return this.handle.db
      .prepare(
        'SELECT * FROM control_plane_phase_launches WHERE run_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(runId) as PhaseLaunchRow[]
  }

  /** Everything the driver should still act on, oldest first. `blocked` is
   *  included because the block is an external condition the operator can clear
   *  by certifying the route; `failed` and `started` are terminal. */
  listActionable(runId: string): PhaseLaunchRow[] {
    return this.handle.db
      .prepare(
        `SELECT * FROM control_plane_phase_launches
         WHERE run_id = ? AND state IN ('pending', 'start_unknown', 'blocked')
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(runId) as PhaseLaunchRow[]
  }

  /** Idempotent: replaying the same plan returns the existing row untouched. */
  recordPlanned(row: {
    phaseId: string
    runId: string
    outcomeId: string
    taskId: string
    kind: Exclude<OutcomePhaseKind, 'build'>
    route: RouteIdentity
    terminalHandle: string | null
    worktreeId: string | null
    boundSha: string
  }): PhaseLaunchRow {
    const existing = this.get(row.phaseId)
    if (existing) {
      return existing
    }
    this.handle.db
      .prepare(
        `INSERT OR IGNORE INTO control_plane_phase_launches
           (phase_id, run_id, outcome_id, task_id, kind, state, agent, model, reasoning,
            terminal_handle, worktree_id, bound_sha)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.phaseId,
        row.runId,
        row.outcomeId,
        row.taskId,
        row.kind,
        row.route.agent,
        row.route.model,
        row.route.reasoning,
        row.terminalHandle,
        row.worktreeId,
        row.boundSha
      )
    // Why the task fallback: the UNIQUE index on task_id can swallow the insert
    // when a phase was re-planned under a new id, and the existing launch is
    // then the correct answer — never a second row.
    return (this.get(row.phaseId) ?? this.getByTask(row.taskId)) as PhaseLaunchRow
  }

  /** Claims one phase for this driver.
   *
   *  The claim is the UPDATE itself: only the writer whose conditional UPDATE
   *  actually changed a row owns the launch. Reading the state back instead
   *  would hand the claim to BOTH racing drivers, because the loser would see
   *  the winner's `starting` and believe it had won. */
  claimForStart(phaseId: string, nowIso: string): boolean {
    const result = this.handle.db
      .prepare(
        `UPDATE control_plane_phase_launches
         SET state = 'starting', attempts = attempts + 1, updated_at = ?
         WHERE phase_id = ? AND state IN ('pending', 'start_unknown', 'blocked')`
      )
      .run(nowIso, phaseId)
    return Number(result.changes) === 1
  }

  markStarted(phaseId: string, dispatchId: string, nowIso: string): void {
    this.handle.db
      .prepare(
        `UPDATE control_plane_phase_launches
         SET state = 'started', dispatch_id = ?, last_error = NULL, updated_at = ?
         WHERE phase_id = ?`
      )
      .run(dispatchId, nowIso, phaseId)
  }

  /** Binds the Dispatch a failed start still created, without leaving the row
   *  in a state the driver would pick up again. */
  recordFailedDispatch(phaseId: string, dispatchId: string, nowIso: string): void {
    this.handle.db
      .prepare(
        'UPDATE control_plane_phase_launches SET dispatch_id = ?, updated_at = ? WHERE phase_id = ?'
      )
      .run(dispatchId, nowIso, phaseId)
  }

  markOutcome(
    phaseId: string,
    state: Extract<PhaseLaunchState, 'start_unknown' | 'blocked' | 'failed'>,
    error: string,
    nowIso: string
  ): void {
    // Why blocked resets attempts: an uncertified route is an external
    // condition, not a failing launch. Counting it against the retry budget
    // would burn the loop out while the operator is still certifying the route.
    const attempts = state === 'blocked' ? ', attempts = 0' : ''
    this.handle.db
      .prepare(
        `UPDATE control_plane_phase_launches
         SET state = ?, last_error = ?, updated_at = ?${attempts}
         WHERE phase_id = ?`
      )
      .run(state, error, nowIso, phaseId)
  }
}
