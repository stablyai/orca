import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from '../server-types'

/** Hook silence, while OSC 7501 disagrees, before OSC 7501 takes the pane. Why minutes: a long
 *  tool call sends no hooks but leaves the program's state unchanged, so only old disagreement counts. */
export const HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS = 2 * 60 * 1000

/** Whether an OSC 7501 projection must leave the pane's hook row alone: hooks carry richer identity,
 *  so they win until silent on a state they no longer describe. A later hook event hands it back. */
export function programStatusYieldsToHookRow(
  previous: EnrichedAgentHookEventPayload | undefined,
  payload: ParsedAgentStatusPayload,
  now: number
): boolean {
  if (previous?.observation?.origin !== 'hook' || previous.providerSessionOnly === true) {
    return false
  }
  const sameAgent =
    payload.agentType === undefined || payload.agentType === previous.payload.agentType
  // A different app after the hook agent finished is a new program in the pane. Mid-turn, the hook
  // row still wins over another app id: forks report upstream's app (OpenClaude says claude-code).
  if (!sameAgent && previous.payload.state === 'done') {
    return false
  }
  const hookSilentForMs = now - previous.receivedAt
  return (
    payload.state === previous.payload.state ||
    hookSilentForMs < HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
  )
}
