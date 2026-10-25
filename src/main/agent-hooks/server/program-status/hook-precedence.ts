import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
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
  if (payload.state === previous.payload.state) {
    return Infinity
  }
  // Settled turns are naturally silent; a later wait must prove intervening program work.
  if (previous.payload.state === 'done' && payload.state === 'waiting') {
    return programWorkingSince !== undefined && programWorkingSince > previous.receivedAt
      ? undefined
      : Infinity
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
