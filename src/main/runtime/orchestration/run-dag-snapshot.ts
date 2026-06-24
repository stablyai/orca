import type {
  OrchestrationRunDag,
  OrchestrationTaskNode,
  OrchestrationTaskSignal
} from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/types'
import { buildOrchestrationTaskDisplayMetadata } from '../../../shared/orchestration-task-display'
import type { DispatchStatus, MessageRow, TaskRow } from './types'

// Why (#6 O1): bound the synced DAG so a runaway run (hundreds of tasks) can't
// bloat every graph-sync tick. The renderer surfaces the overflow count rather
// than silently dropping rows.
export const RUN_DAG_TASK_CAP = 200

// Why: only the latest heartbeat/worker_done per dispatch is worth syncing, so
// scan a bounded window of recent coordinator-addressed messages rather than the
// whole history.
export const RUN_DAG_SIGNAL_SCAN_LIMIT = 500

/** A task joined with its active dispatch — the shape of
 *  `OrchestrationDb.listTasksWithDispatch()` rows. */
export type TaskWithDispatchRow = TaskRow & {
  assignee_handle: string | null
  dispatch_id: string | null
  dispatch_status: DispatchStatus | null
  dispatch_last_heartbeat_at: string | null
  dispatch_dispatched_at: string | null
}

function parseDeps(depsJson: string): string[] {
  try {
    const parsed = JSON.parse(depsJson)
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : []
  } catch {
    return []
  }
}

// Why (#3): key the worker signal by taskId, not dispatchId. listTasksWithDispatch
// joins only pending/dispatched dispatches, so a COMPLETED task's row has
// dispatch_id = null — a dispatch-keyed signal would never reach the very rows
// that carry the worker_done summary. taskId is on both heartbeat and worker_done
// payloads (the preamble's --task-id) and is stable across a task's retries.
function parseTaskId(payload: string | null): string | null {
  if (!payload) {
    return null
  }
  try {
    const parsed = JSON.parse(payload) as { taskId?: unknown }
    return typeof parsed.taskId === 'string' && parsed.taskId.length > 0 ? parsed.taskId : null
  } catch {
    return null
  }
}

function parsePhase(payload: string | null): string | null {
  if (!payload) {
    return null
  }
  try {
    const parsed = JSON.parse(payload) as { phase?: unknown }
    return typeof parsed.phase === 'string' && parsed.phase.trim().length > 0
      ? parsed.phase.trim()
      : null
  } catch {
    return null
  }
}

function summaryFromWorkerDone(msg: MessageRow): string | null {
  // Why: the worker_done body is the 3-sentence summary; the subject is the
  // short status. Prefer the subject (one line, scannable) and fall back to the
  // first line of the body.
  const subject = msg.subject.trim()
  if (subject.length > 0) {
    return subject
  }
  const firstBodyLine = msg.body.split(/\r?\n/, 1)[0]?.trim()
  return firstBodyLine && firstBodyLine.length > 0 ? firstBodyLine : null
}

/** Map taskId → its most recent worker signal. `messages` MUST be ordered
 *  newest-first (sequence DESC); the first signal seen per task wins. */
export function indexLatestWorkerSignals(
  messages: MessageRow[]
): Map<string, OrchestrationTaskSignal> {
  const byTask = new Map<string, OrchestrationTaskSignal>()
  for (const msg of messages) {
    if (msg.type !== 'heartbeat' && msg.type !== 'worker_done') {
      continue
    }
    const taskId = parseTaskId(msg.payload)
    if (!taskId || byTask.has(taskId)) {
      continue
    }
    byTask.set(
      taskId,
      msg.type === 'heartbeat'
        ? { phase: parsePhase(msg.payload), summary: null }
        : { phase: null, summary: summaryFromWorkerDone(msg) }
    )
  }
  return byTask
}

function toTaskNode(
  row: TaskWithDispatchRow,
  staleThresholdIso: string,
  signalsByTaskId: Map<string, OrchestrationTaskSignal>,
  resolveAgent: (handle: string) => TuiAgent | null
): OrchestrationTaskNode {
  // Why (nit): fall back to the task id so a blank spec can't render an empty row.
  const title =
    buildOrchestrationTaskDisplayMetadata({
      spec: row.spec,
      taskTitle: row.task_title,
      displayName: row.display_name
    }).displayName || row.id

  // The LEFT JOIN only surfaces a pending/dispatched dispatch, so an assignee
  // means there is a live dispatch backing this task.
  const dispatch =
    row.assignee_handle || row.dispatch_id
      ? {
          assigneeHandle: row.assignee_handle,
          assigneeAgent: row.assignee_handle ? resolveAgent(row.assignee_handle) : null,
          status: row.dispatch_status ?? 'pending',
          lastHeartbeatAt: row.dispatch_last_heartbeat_at,
          // Why (#4): match getStaleDispatches exactly — a dispatched worker is
          // stalled only once it is PAST the dispatched-at grace AND its heartbeat
          // (or null heartbeat) predates the threshold. Without the dispatched_at
          // grace a freshly-dispatched worker would flash amber before its first
          // heartbeat is due, disagreeing with the aggregate stalled count.
          stale:
            row.dispatch_status === 'dispatched' &&
            row.dispatch_dispatched_at !== null &&
            row.dispatch_dispatched_at < staleThresholdIso &&
            (row.dispatch_last_heartbeat_at === null ||
              row.dispatch_last_heartbeat_at < staleThresholdIso)
        }
      : null

  // Why (#3): key by task id so a completed task's worker_done summary lands.
  const signal = signalsByTaskId.get(row.id) ?? null

  return {
    id: row.id,
    status: row.status,
    deps: parseDeps(row.deps),
    title,
    targetKey: row.target_key,
    dispatch,
    signal
  }
}

/** Assemble a run's task DAG snapshot from already-fetched DB rows. Pure: all
 *  DB/clock/agent lookups are injected so the mapping is unit-testable. */
export function buildRunDagSnapshot(input: {
  runId: string
  recipe: string | null
  tasks: TaskWithDispatchRow[]
  staleThresholdIso: string
  signalsByTaskId: Map<string, OrchestrationTaskSignal>
  resolveAgent: (handle: string) => TuiAgent | null
  taskCap?: number
}): OrchestrationRunDag {
  const cap = input.taskCap ?? RUN_DAG_TASK_CAP
  const capped = input.tasks.slice(0, cap)
  const truncatedTaskCount = Math.max(0, input.tasks.length - capped.length)
  return {
    runId: input.runId,
    recipe: input.recipe,
    tasks: capped.map((row) =>
      toTaskNode(row, input.staleThresholdIso, input.signalsByTaskId, input.resolveAgent)
    ),
    truncatedTaskCount
  }
}
