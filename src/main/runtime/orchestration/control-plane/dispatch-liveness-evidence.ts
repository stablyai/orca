import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { exposeUtcTimestamp } from '../db/utc-timestamp'
import type { DispatchContextRow } from '../types'
import type { LivenessEvidence } from './dispatch-liveness'

/** B4 (correction 2) — the adapter from Orca's authoritative runtime signals to
 *  the typed liveness evidence the classifier consumes.
 *
 *  Every field comes from something the runtime itself observed:
 *   - process/session state: `inspectTerminalProcessIncarnationLiveness`, the
 *     same PTY-table probe `worker-release` and `worker-stop` already trust;
 *   - last output/activity: the agent-hook row's `receivedAt`, which is stamped
 *     when the hook server received the event, not by the model;
 *   - active tool call: the hook row's `toolName`;
 *   - approved blocking wait: an Orca-owned wait the runtime registered for
 *     this Dispatch (`ask`, `check --wait`, `await`);
 *   - provider exit: the Dispatch row's recorded termination reason;
 *   - terminal state: whether the worker terminal resource is still owned.
 *
 *  Nothing here reads a model-authored heartbeat.
 */

export type DispatchLivenessSignals = {
  dispatch: DispatchContextRow
  /** Newest agent-hook row for the Dispatch's pane, or null when none exists. */
  agentStatus: Pick<
    AgentStatusIpcPayload,
    'state' | 'toolName' | 'receivedAt' | 'interactivePrompt'
  > | null
  /** Verdict from the execution host's process table. */
  processLiveness: 'live' | 'exited' | 'unverifiable'
  /** True while the runtime holds an Orca-approved blocking wait for this Dispatch. */
  approvedWaitUntilIso: string | null
  /** Ownership state of the worker terminal resource, when one exists. */
  terminalOwnership: string | null
  /** Epoch ms of the last output the runtime itself observed on the worker's
   *  terminal, when the execution host can report one. This is Orca's own PTY
   *  stream, not anything the model wrote — a worker that keeps producing
   *  output without emitting a new hook event is working, not stalled. */
  lastTerminalOutputAtMs: number | null
  /** True once the Dispatch reached a settled lifecycle status. */
  settled: boolean
}

const PROCESS_STATE_BY_VERDICT = {
  live: 'running',
  exited: 'exited',
  unverifiable: 'unknown'
} as const satisfies Record<
  DispatchLivenessSignals['processLiveness'],
  LivenessEvidence['processState']
>

// Why these two only: `released` and `user_owned` mean Orca no longer owns the
// pane, so it cannot be evidence of a live worker. `transferred` and `external`
// still have an owner running the Dispatch.
const CLOSED_TERMINAL_OWNERSHIP = new Set(['released', 'user_owned'])

/** The newest AUTHORITATIVE activity the runtime observed, across every source
 *  it owns. Hook events and terminal output are both real activity; taking only
 *  the hook stamp made a worker that was visibly producing output look stalled
 *  the moment its agent stopped emitting hook events. */
function newestActivityIso(
  signals: DispatchLivenessSignals,
  dispatch: DispatchContextRow
): string | null {
  const candidates: number[] = []
  if (signals.agentStatus) {
    candidates.push(signals.agentStatus.receivedAt)
  }
  if (signals.lastTerminalOutputAtMs !== null) {
    candidates.push(signals.lastTerminalOutputAtMs)
  }
  if (candidates.length === 0) {
    // Why exposeUtcTimestamp: dispatch rows keep SQLite's timezone-less UTC
    // space format, which Date.parse would read as LOCAL time and skew the
    // stall window by the host's offset.
    return exposeUtcTimestamp(dispatch.dispatched_at)
  }
  return new Date(Math.max(...candidates)).toISOString()
}

export function toLivenessEvidence(signals: DispatchLivenessSignals): LivenessEvidence {
  const { dispatch } = signals
  const settled =
    signals.settled ||
    dispatch.status === 'completed' ||
    dispatch.status === 'failed' ||
    dispatch.status === 'circuit_broken'

  // Why only `signaled`/`exited`: `operator_close` is a deliberate stop and
  // `unknown` establishes nothing, so neither is a crash.
  const providerExit =
    !settled &&
    (dispatch.termination_reason === 'signaled' || dispatch.termination_reason === 'exited')
      ? { code: null, signal: dispatch.termination_reason }
      : null

  return {
    processState: PROCESS_STATE_BY_VERDICT[signals.processLiveness],
    // Why exposeUtcTimestamp: dispatch rows keep SQLite's timezone-less UTC
    // space format, which Date.parse would read as LOCAL time and skew the
    // stall window by the host's offset.
    lastActivityAt: newestActivityIso(signals, dispatch),
    // Why a non-empty toolName: the hook stamps it for the duration of the call,
    // so its presence is the runtime's own proof that work is in flight.
    activeToolCall: Boolean(signals.agentStatus?.toolName),
    approvedBlockingWaitUntil: signals.approvedWaitUntilIso,
    providerExit,
    terminalState:
      signals.terminalOwnership && CLOSED_TERMINAL_OWNERSHIP.has(signals.terminalOwnership)
        ? 'closed'
        : 'attached',
    settled
  }
}

/** Picks the newest hook row that belongs to this Dispatch. Pane match is the
 *  authority; the orchestration stamp is a stronger match when present. */
export function selectDispatchAgentStatus(
  dispatch: DispatchContextRow,
  statuses: readonly AgentStatusIpcPayload[]
): AgentStatusIpcPayload | null {
  const forDispatch = statuses.filter(
    (row) => row.orchestration?.dispatchId === dispatch.id && row.providerSessionOnly !== true
  )
  const candidates =
    forDispatch.length > 0
      ? forDispatch
      : statuses.filter(
          (row) =>
            row.providerSessionOnly !== true &&
            ((dispatch.assignee_pane_key !== null && row.paneKey === dispatch.assignee_pane_key) ||
              (dispatch.assignee_handle !== null &&
                row.terminalHandle === dispatch.assignee_handle))
        )
  return candidates.sort((left, right) => right.receivedAt - left.receivedAt)[0] ?? null
}
