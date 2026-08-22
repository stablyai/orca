import {
  buildFleetEcho,
  FLEET_ECHO_SCAN_LIMIT,
  type FleetEcho,
  type FleetEchoDispatch,
  type FleetEchoSources,
  type FleetEchoTerminalSignal
} from '../../../../shared/orchestration-fleet-echo'
import { exposeUtcTimestamp } from '../../orchestration/db/utc-timestamp'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

type ActiveDispatchRow = {
  id: string
  task_id: string
  assignee_handle: string | null
  status: string
  dispatched_at: string | null
  last_heartbeat_at: string | null
}

// Why: SQLite's datetime('now') writes timezone-less UTC ("YYYY-MM-DD HH:MM:SS"); V8's Date.parse
// reads that as local time, so normalize through exposeUtcTimestamp before parsing (#8452). An
// unparseable value must degrade to null instead of poisoning comparisons with NaN.
function parseSqliteTimestamp(value: string | null): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(exposeUtcTimestamp(value) ?? value)
  return Number.isFinite(parsed) ? parsed : null
}

export type FleetEchoRuntimeDeps = {
  listActiveDispatchesForRun(runId: string, limit: number): ActiveDispatchRow[]
  getWorkerDispatchStage(dispatchId: string): string | null
  getTerminalSignal(handle: string): FleetEchoTerminalSignal | null
  now(): number
}

function toBuilderDispatch(row: ActiveDispatchRow): FleetEchoDispatch | null {
  if (row.status !== 'pending' && row.status !== 'dispatched') {
    return null
  }
  return {
    dispatchId: row.id,
    taskId: row.task_id,
    assigneeHandle: row.assignee_handle,
    status: row.status,
    dispatchedAt: parseSqliteTimestamp(row.dispatched_at),
    lastHeartbeatAt: parseSqliteTimestamp(row.last_heartbeat_at)
  }
}

export function createFleetEchoSources(
  deps: FleetEchoRuntimeDeps,
  runId: string
): FleetEchoSources {
  return {
    // Why: fetch one past the scan window so the builder can tell a full window from a truncated
    // one. The window is wider than the lane cap because the builder ranks by severity before
    // cutting, and severity needs the runtime signals a SQL LIMIT cannot see.
    listActiveDispatches: () =>
      deps
        .listActiveDispatchesForRun(runId, FLEET_ECHO_SCAN_LIMIT + 1)
        .map(toBuilderDispatch)
        .filter((entry): entry is FleetEchoDispatch => entry !== null),
    getWorkerStage: (dispatchId) => deps.getWorkerDispatchStage(dispatchId),
    getTerminalSignal: (handle) => deps.getTerminalSignal(handle),
    now: () => deps.now()
  }
}

// Why: `connected` tracks the shell PTY, not the agent process inside it — a dead agent in a
// live shell still reads connected. No PTY proves no agent (`dead`); a live PTY proves nothing
// about that specific worker incarnation, so it must stay `unknown` rather than `live`.
function resolveLocalTerminalSignal(summary: RuntimeTerminalSummary): FleetEchoTerminalSignal {
  return {
    lastOutputAt: summary.lastOutputAt,
    processState: summary.connected ? 'unknown' : 'dead'
  }
}

// Why: a federated lane's handle never resolves locally, so it is simply absent from the
// map — getTerminalSignal below returns null for it and the builder maps that to 'unknown'.
async function resolveHandleSignals(
  runtime: OrcaRuntimeService,
  handles: readonly string[]
): Promise<ReadonlyMap<string, FleetEchoTerminalSignal>> {
  const uniqueHandles = [...new Set(handles)]
  if (uniqueHandles.length === 0) {
    return new Map()
  }
  const summaries = await runtime.listTerminalSummariesForHandles(uniqueHandles)
  return new Map(summaries.map((summary) => [summary.handle, resolveLocalTerminalSignal(summary)]))
}

export function createFleetEchoRuntimeDeps(
  runtime: OrcaRuntimeService,
  handleSignals: ReadonlyMap<string, FleetEchoTerminalSignal>
): FleetEchoRuntimeDeps {
  const db = runtime.getOrchestrationDb()
  return {
    listActiveDispatchesForRun: (runId, limit) => db.listActiveDispatchesForRun(runId, limit),
    getWorkerDispatchStage: (dispatchId) => db.getWorkerDispatch(dispatchId)?.stage ?? null,
    getTerminalSignal: (handle) => handleSignals.get(handle) ?? null,
    now: () => Date.now()
  }
}

// Why: FleetEchoRuntimeDeps.getTerminalSignal is synchronous by design (Task 3), but the
// runtime's terminal read is async — so this resolves every active lane's terminal signal
// up front, once, before building the synchronous deps the sources/builder pipeline expects.
export async function attachFleetEcho<T extends object>(
  runtime: OrcaRuntimeService,
  runId: string | null,
  enabled: boolean,
  result: T
): Promise<T & { fleet?: FleetEcho }> {
  if (!enabled || !runId) {
    return result
  }
  try {
    const db = runtime.getOrchestrationDb()
    const rows = db.listActiveDispatchesForRun(runId, FLEET_ECHO_SCAN_LIMIT + 1)
    const handles = rows
      .map((row) => row.assignee_handle)
      .filter((handle): handle is string => handle !== null)
    const handleSignals = await resolveHandleSignals(runtime, handles)
    // Why: reuse the one row read for both the handle map and the builder's row set — a second
    // query here would let a lane settle between reads and disagree with the builder's `truncated`.
    const deps: FleetEchoRuntimeDeps = {
      ...createFleetEchoRuntimeDeps(runtime, handleSignals),
      listActiveDispatchesForRun: () => rows
    }
    return { ...result, fleet: buildFleetEcho(runId, createFleetEchoSources(deps, runId)) }
  } catch {
    // Why: the block is an informational passenger; a failed read must not fail the command.
    return result
  }
}

/** The Run the calling terminal is bound to, or null when it is bound to none. */
export function resolveCallerRunId(
  runtime: OrcaRuntimeService,
  callerTerminalHandle: string | undefined
): string | null {
  if (!callerTerminalHandle) {
    return null
  }
  const paneKey = runtime.getTerminalPaneKey(callerTerminalHandle)
  if (!paneKey) {
    return null
  }
  return runtime.getOrchestrationDb().getCurrentRunForPane(paneKey)?.id ?? null
}

// Why: some handlers reach a Run through the thing they were asked about — a task, a message —
// rather than through the caller. Echoing that Run would hand its lane roster to anyone able to
// name an id inside it, so those sites gate on the caller owning the same Run.
export function runIdIfCallerOwns(
  runtime: OrcaRuntimeService,
  callerTerminalHandle: string | undefined,
  targetRunId: string | null | undefined
): string | null {
  if (!targetRunId) {
    return null
  }
  return resolveCallerRunId(runtime, callerTerminalHandle) === targetRunId ? targetRunId : null
}
