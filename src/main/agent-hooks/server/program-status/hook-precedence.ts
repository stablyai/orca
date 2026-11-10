import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status/contracts/agent-status-types'
import { isAgentStatusHeldOpenByChildWork } from '../../../../shared/agent-status/lifecycle/agent-lead-status-fold'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { EnrichedAgentHookEventPayload } from '../server-types'

// Long tool calls can be hook-silent; allow sustained disagreement before yielding to OSC 7501.
export const HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS = 2 * 60 * 1000

/** Hook precedence ends at this time; undefined means no yield, Infinity means silence cannot end it. */
export function programStatusHookYieldEndsAt(
  previous: EnrichedAgentHookEventPayload | undefined,
  payload: ParsedAgentStatusPayload,
  programWorkingSince?: number
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
  // agy reports no end for a backgrounded command that never exits, so its hold lapses after hook silence.
  if (
    payload.state === 'done' &&
    payload.sessionBoundary !== true &&
    previous.payload.agentType === 'antigravity' &&
    previous.payload.workingMode === 'monitoring' &&
    isAgentStatusHeldOpenByChildWork(previous.payload)
  ) {
    return previous.receivedAt + AGENT_STATUS_STALE_AFTER_MS
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
  // A settled turn yields only to program work begun after it (a replayed done keeps its own time):
  // Codex re-reports the settled turn's working while a background terminal it started runs.
  if (
    previous.payload.state === 'done' &&
    (payload.state === 'waiting' || payload.state === 'working')
  ) {
    const doneAt = previous.evidenceObservedAt ?? previous.receivedAt
    if (programWorkingSince === undefined || programWorkingSince <= doneAt) {
      return Infinity
    }
    return payload.state === 'waiting'
      ? undefined
      : previous.receivedAt + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
  }
  // A question sends no hooks while open, so a `working` that began before it (e.g. re-sent by the
  // lease renewal) proves nothing; a working transition after it keeps the silence fallback.
  if (
    (previous.payload.state === 'waiting' || previous.payload.state === 'blocked') &&
    payload.state === 'working' &&
    programWorkingSince !== undefined &&
    programWorkingSince <= previous.receivedAt
  ) {
    return Infinity
  }
  return previous.receivedAt + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
}
