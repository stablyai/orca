import { INTERRUPTED_TURN_LATE_PROGRESS_MS, TOOL_PROGRESS_HOOK_EVENTS } from './server-constants'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'

/** `hold` names the already-applied row to keep; otherwise `payload` is applied, possibly amended. */
export type InterruptedTurnProgress =
  | { hold: EnrichedAgentHookEventPayload }
  | { hold: null; payload: AgentHookEventPayload }

/**
 * True when `next` reports the same turn `previous` already recorded stopped, rather than a new one.
 * There is no turn id on this wire, so identity is the pane's agent and prompt plus a short window;
 * a new prompt, a different agent, or a long gap all read as a new turn. Claude and Codex label
 * tool lifecycle work, which a same-prompt retry (another UserPromptSubmit) never is, so for them
 * the label answers it and no clock is needed.
 */
function reportsTheStoppedTurn(
  previous: EnrichedAgentHookEventPayload,
  next: AgentHookEventPayload,
  now: number
): boolean {
  if (
    previous.payload.agentType !== next.payload.agentType ||
    previous.payload.prompt !== next.payload.prompt
  ) {
    return false
  }
  if (
    (next.payload.agentType === 'claude' || next.payload.agentType === 'codex') &&
    next.hookEventName !== undefined &&
    TOOL_PROGRESS_HOOK_EVENTS.has(next.hookEventName)
  ) {
    return true
  }
  return (
    next.hasExplicitPrompt !== true &&
    now - previous.receivedAt <= INTERRUPTED_TURN_LATE_PROGRESS_MS
  )
}

/**
 * What a hook belonging to a turn the user already stopped is allowed to do to that pane's row.
 * Two arms, because "arrived late" and "was sent again" are different things:
 *
 * - a **replay** is re-delivery of evidence the interrupt already superseded, not a new sighting of
 *   the pane, so it may not restate the pane's state. It is dated to the original observation
 *   (`resolveEvidenceObservedAt`), which is older than the interrupt, so letting it through would
 *   walk the row backwards in time. The held row is the newer one;
 * - **new evidence** from that turn — a tool step still in flight when the user pressed Ctrl+C, or
 *   the agent's own terminal report — is published as the work it reports and inherits the fact
 *   that the user stopped the turn.
 *
 * The second arm used to freeze the row on the stopped `done` as well. That hid a tool the agent
 * was genuinely still running and pinned a stale timestamp, and it was only ever needed because
 * `interrupted` could not ride any row but a `done` one.
 */
export function resolveInterruptedTurnProgress(
  previous: EnrichedAgentHookEventPayload | undefined,
  next: AgentHookEventPayload,
  now: number
): InterruptedTurnProgress {
  if (
    previous?.payload.interrupted !== true ||
    previous.payload.agentType !== next.payload.agentType ||
    previous.payload.prompt !== next.payload.prompt
  ) {
    return { hold: null, payload: next }
  }
  if (next.isReplay === true) {
    return { hold: previous }
  }
  if (next.payload.interrupted === true || !reportsTheStoppedTurn(previous, next, now)) {
    return { hold: null, payload: next }
  }
  return { hold: null, payload: { ...next, payload: { ...next.payload, interrupted: true } } }
}
