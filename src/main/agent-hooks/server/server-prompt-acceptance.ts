import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentPromptAcceptance } from '../../../shared/agent-status-ipc-payload'

/** The main agent's own prompt submission: the provider accepted a prompt into a turn. A child's
 *  submission or a relay replay restates nothing new about the main agent. */
export function isMainAgentPromptSubmission(event: AgentHookEventPayload): boolean {
  return (
    event.hookEventName === 'UserPromptSubmit' &&
    event.toolAgentId === undefined &&
    event.isReplay !== true
  )
}

/** Stamped by the submission itself and carried by every later event on the pane, so a tool or
 *  session-start ping can neither forge nor erase it. */
export function resolvePromptAcceptance(
  previous: AgentPromptAcceptance | undefined,
  incoming: AgentHookEventPayload,
  acceptedAt: number
): AgentPromptAcceptance | undefined {
  if (!isMainAgentPromptSubmission(incoming)) {
    return previous
  }
  return incoming.providerPromptId
    ? { acceptedAt, providerTurnId: incoming.providerPromptId }
    : { acceptedAt }
}
