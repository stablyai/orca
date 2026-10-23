import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from '../server-types'

/** Hook silence, while OSC 7501 disagrees, before OSC 7501 takes the pane. Why minutes: a long
 *  tool call sends no hooks but leaves the program's state unchanged, so only old disagreement counts. */
export const HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS = 2 * 60 * 1000

/** Until when an OSC 7501 projection must leave the pane's hook row alone: hooks carry richer identity,
 *  so they win until silent on a state they no longer describe. A later hook event hands it back.
 *  `undefined`: it does not yield; `Infinity`: no silence ends the yield.
 *  `programWorkingSince`: when the program last entered `working` (ProgramStatusFacetStore). */
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
  // A different app after the hook agent finished is a new program in the pane. Mid-turn, the hook
  // row still wins over another app id: forks report upstream's app (OpenClaude says claude-code).
  if (!sameAgent && previous.payload.state === 'done') {
    return undefined
  }
  if (payload.state === previous.payload.state) {
    return Infinity
  }
  // Hooks fall silent after a settled turn by design, so silence proves nothing there; an approval or
  // question only outranks them once the program has worked since (a turn the hooks missed).
  if (previous.payload.state === 'done' && payload.state === 'waiting') {
    return programWorkingSince !== undefined && programWorkingSince > previous.receivedAt
      ? undefined
      : Infinity
  }
  return previous.receivedAt + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
}
