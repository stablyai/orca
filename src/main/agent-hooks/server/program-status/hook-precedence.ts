import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import { isAgentStatusHeldOpenByChildWork } from '../../../../shared/agent-lead-status-fold'
import type { EnrichedAgentHookEventPayload } from '../server-types'

// Long tool calls can be hook-silent; allow sustained disagreement before yielding to OSC 7501.
export const HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS = 2 * 60 * 1000

/** Hook precedence ends at this time; undefined means no yield, Infinity means silence cannot end it. */
export function programStatusHookYieldEndsAt(
  previous: EnrichedAgentHookEventPayload | undefined,
  payload: ParsedAgentStatusPayload,
  programWorkingSince?: number,
  renewsProgramStatusLease?: true
): number | undefined {
  if (previous?.observation?.origin !== 'hook' || previous.providerSessionOnly === true) {
    return undefined
  }
  const sameAgent =
    payload.agentType === undefined || payload.agentType === previous.payload.agentType
  // Different app IDs can be forks; only a completed hook agent lets a different program take over immediately.
  if (!sameAgent && previous.payload.state === 'done') {
    return undefined
  }
  // Hook and program child rosters cannot settle or reopen each other's turns.
  if (
    payload.state === previous.payload.state ||
    (previous.payload.state === 'done' && isAgentStatusHeldOpenByChildWork(payload)) ||
    (payload.state === 'done' &&
      payload.sessionBoundary !== true &&
      isAgentStatusHeldOpenByChildWork(previous.payload))
  ) {
    return Infinity
  }
  // Settled turns are naturally silent; a later wait must prove intervening program work.
  if (previous.payload.state === 'done' && payload.state === 'waiting') {
    return programWorkingSince !== undefined && programWorkingSince > previous.receivedAt
      ? undefined
      : Infinity
  }
  // A question sends no hooks while open, so a `working` that began before it proves nothing when it
  // is only re-sent by the lease renewal (#32066). A fresh report of that same run (#37003) shows the
  // program resumed — a declined Claude permission emits no hook — so the silence fallback may take
  // the row once the hooks stay silent.
  if (
    (previous.payload.state === 'waiting' || previous.payload.state === 'blocked') &&
    payload.state === 'working' &&
    programWorkingSince !== undefined &&
    programWorkingSince <= previous.receivedAt &&
    renewsProgramStatusLease === true
  ) {
    return Infinity
  }
  return previous.receivedAt + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
}

/** The ingest entry: only program-status reports yield to hook precedence, and the lease marker rides beside them. */
export function programStatusReportYieldEndsAt(
  previous: EnrichedAgentHookEventPayload | undefined,
  payload: ParsedAgentStatusPayload,
  programWorkingSince: number | undefined,
  event: { fromProgramStatus?: true; renewsProgramStatusLease?: true }
): number | undefined {
  if (event.fromProgramStatus !== true) {
    return undefined
  }
  return programStatusHookYieldEndsAt(
    previous,
    payload,
    programWorkingSince,
    event.renewsProgramStatusLease
  )
}
