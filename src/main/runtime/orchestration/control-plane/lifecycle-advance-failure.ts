import type { OrchestrationDb } from '../db'
import type { DispatchContextRow } from '../types'
import { ControlPlaneStore } from './control-plane-store'
import { advanceAfterValidatedCompletion, type AdvanceOutcome } from './lifecycle-advance'
import { parseCompletionClaim, type CompletionClaim } from './completion-receipt'
import { resolveOutcomeBinding } from './outcome-identity'
import { WAKE_REASON_PAYLOAD_KEY } from './coordinator-wake-events'

/** What happens AFTER a completion is accepted.
 *
 *  A completion that passed the gate has already been settled, so an exception
 *  while advancing the lifecycle must never undo it. But swallowing that
 *  exception is how a Run silently strands: the work is done, the next phase
 *  never launches, and nothing anywhere records why.
 *
 *  So the failure is persisted with the exact inputs needed to replay it, keyed
 *  by the source Dispatch so a retry is idempotent, and reconciled on the next
 *  wake. When replay keeps failing, the row becomes a protected blocker a human
 *  can see rather than a Run that quietly stopped moving.
 */

/** Runtime hooks the reconcile path threads through so the control plane can
 *  wake waiters and bind evidence to the current build without importing the
 *  runtime service. All optional: a plain `reconcileLifecycleMessage(db, msg)`
 *  from a test or the in-process coordinator behaves exactly as before. */
export type LifecycleReconciliationHooks = {
  notify?: (handle: string, messageType: string) => void
  currentCommitSha?: string
  currentRuntimeVersion?: string
  nowMs?: number
}

export type LifecycleAdvanceFailureResult = {
  /** Dispatches whose advance replayed successfully on this pass. */
  resolved: string[]
  /** Dispatches still failing, now carrying a protected blocker. */
  blocked: string[]
}

/** Beyond this many replays the failure is not transient and a human has to see
 *  it. Bounded rather than infinite so a permanently broken transition cannot
 *  spin on every wake forever. */
const MAX_ADVANCE_ATTEMPTS = 3

type FailureRow = {
  source_dispatch_id: string
  run_id: string
  task_id: string
  outcome_id: string
  payload_json: string
  final_sha: string
  outcome_of_report: 'succeeded' | 'failed'
  error: string
  state: 'retryable' | 'resolved'
  attempts: number
  blocker_message_id: string | null
}

function readStringArray(payload: Record<string, unknown>, key: string): string[] {
  const raw = payload[key]
  return Array.isArray(raw) && raw.every((item) => typeof item === 'string')
    ? (raw as string[])
    : []
}

/** The single production call site for the post-completion lifecycle. Failures
 *  are contained: an advance error must never undo an already-settled,
 *  already-gate-proven completion — but it is recorded, not dropped. */
export function advanceAfterAcceptedCompletion(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  taskId: string
  payload: Record<string, unknown>
  /** The claim the gate already proved. Passed in rather than re-parsed so the
   *  advance can never act on a different reading of the payload than the one
   *  that was admitted. */
  claim?: CompletionClaim
  finalSha: string
  outcomeOfReport: 'succeeded' | 'failed'
  onLog: (message: string) => void
  hooks?: LifecycleReconciliationHooks
}): AdvanceOutcome | null {
  const parsed = parseCompletionClaim(args.payload)
  const claim = args.claim ?? (parsed.present ? parsed.claim : null)
  if (!claim) {
    return null
  }
  try {
    return advanceAfterValidatedCompletion({
      db: args.db,
      dispatch: args.dispatch,
      taskId: args.taskId,
      claim: { ...claim, headSha: args.finalSha },
      corrections: readStringArray(args.payload, 'corrections'),
      filesModified: readStringArray(args.payload, 'filesModified'),
      outcomeOfReport: args.outcomeOfReport,
      nowMs: args.hooks?.nowMs ?? Date.now(),
      currentCommitSha: args.hooks?.currentCommitSha,
      currentRuntimeVersion: args.hooks?.currentRuntimeVersion,
      notify: args.hooks?.notify
    })
  } catch (error) {
    args.onLog(`Lifecycle advance failed after completion: ${String(error)}`)
    persistLifecycleAdvanceFailure({
      db: args.db,
      dispatch: args.dispatch,
      taskId: args.taskId,
      payload: args.payload,
      finalSha: args.finalSha,
      outcomeOfReport: args.outcomeOfReport,
      error
    })
    return null
  }
}

/** Records the exact replay input, keyed by the source Dispatch so a repeated
 *  failure updates one row rather than accumulating duplicates. */
function persistLifecycleAdvanceFailure(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  taskId: string
  payload: Record<string, unknown>
  finalSha: string
  outcomeOfReport: 'succeeded' | 'failed'
  error: unknown
}): void {
  const outcome = new ControlPlaneStore(args.db).getOutcomeByRun(args.dispatch.run_id)
  try {
    args.db.db
      .prepare(
        `INSERT INTO control_plane_lifecycle_advance_failures
           (source_dispatch_id, run_id, task_id, outcome_id, payload_json, final_sha,
            outcome_of_report, error, state, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'retryable', 1)
         ON CONFLICT(source_dispatch_id) DO UPDATE SET
           attempts = attempts + 1,
           error = excluded.error,
           updated_at = datetime('now')`
      )
      .run(
        args.dispatch.id,
        args.dispatch.run_id,
        args.taskId,
        outcome?.outcome_id ?? '',
        JSON.stringify(args.payload),
        args.finalSha,
        args.outcomeOfReport,
        String(args.error)
      )
  } catch {
    // The completion itself is already settled and gate-proven. Failing to
    // record why the follow-on stalled must not throw back into that path.
  }
}

function existingLifecycleBlockerId(db: OrchestrationDb, dispatchId: string): string | null {
  const row = db.db
    .prepare(
      `SELECT blocker_message_id AS id FROM control_plane_lifecycle_advance_failures
       WHERE source_dispatch_id = ?`
    )
    .get(dispatchId) as { id: string | null } | undefined
  return row?.id ?? null
}

/** Replays every recorded post-completion failure for a Run.
 *
 *  Called on ordinary wakes rather than from a timer, so a Run that is being
 *  interacted with reconciles itself. Idempotent: a row that replays cleanly is
 *  marked resolved, and one that has exhausted its attempts publishes exactly
 *  one protected blocker. */
export function reconcileLifecycleAdvanceFailures(args: {
  db: OrchestrationDb
  runId: string
  hooks?: LifecycleReconciliationHooks
}): LifecycleAdvanceFailureResult {
  const result: LifecycleAdvanceFailureResult = { resolved: [], blocked: [] }
  let pending: FailureRow[]
  try {
    pending = args.db.db
      .prepare(
        `SELECT source_dispatch_id, run_id, task_id, outcome_id, payload_json, final_sha,
                outcome_of_report, error, state, attempts, blocker_message_id
         FROM control_plane_lifecycle_advance_failures
         WHERE run_id = ? AND state = 'retryable'
         ORDER BY created_at ASC`
      )
      .all(args.runId) as FailureRow[]
  } catch {
    return result
  }
  for (const row of pending) {
    const dispatch = args.db.getDispatchContextById(row.source_dispatch_id)
    if (!dispatch) {
      continue
    }
    // Why re-check the binding: the outcome may have closed while this sat
    // unresolved, and replaying into a closed outcome would reopen it.
    if (
      resolveOutcomeBinding(new ControlPlaneStore(args.db), row.run_id).kind === 'legacy_unbound'
    ) {
      continue
    }
    const replayed = advanceAfterAcceptedCompletion({
      db: args.db,
      dispatch,
      taskId: row.task_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      finalSha: row.final_sha,
      outcomeOfReport: row.outcome_of_report,
      onLog: () => undefined,
      ...(args.hooks ? { hooks: args.hooks } : {})
    })
    if (replayed) {
      args.db.db
        .prepare(
          `UPDATE control_plane_lifecycle_advance_failures
           SET state = 'resolved', updated_at = datetime('now')
           WHERE source_dispatch_id = ?`
        )
        .run(row.source_dispatch_id)
      result.resolved.push(row.source_dispatch_id)
      continue
    }
    if (
      row.attempts + 1 < MAX_ADVANCE_ATTEMPTS ||
      existingLifecycleBlockerId(args.db, row.source_dispatch_id)
    ) {
      continue
    }
    const message = args.db.insertMessage({
      runId: row.run_id,
      from: 'orca:runtime-lifecycle',
      to: `run:${row.run_id}`,
      subject: 'Protected blocker: lifecycle_advance_failed',
      body: `Task ${row.task_id} completed and passed its gates, but the next phase could not be started after ${row.attempts + 1} attempts: ${row.error}`,
      type: 'escalation',
      priority: 'urgent',
      payload: JSON.stringify({
        [WAKE_REASON_PAYLOAD_KEY]: 'escalation',
        protectedBlocker: true,
        code: 'lifecycle_advance_failed',
        sourceDispatchId: row.source_dispatch_id,
        taskId: row.task_id,
        outcomeId: row.outcome_id
      })
    })
    args.db.db
      .prepare(
        `UPDATE control_plane_lifecycle_advance_failures
         SET blocker_message_id = ?, updated_at = datetime('now')
         WHERE source_dispatch_id = ?`
      )
      .run(message.id, row.source_dispatch_id)
    args.hooks?.notify?.(`run:${row.run_id}`, 'escalation')
    result.blocked.push(row.source_dispatch_id)
  }
  return result
}
