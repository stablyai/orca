import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'

type KnownStatus = { connectionId: string | null; payload: ParsedAgentStatusPayload }

/** Reports whether a hook status event changed anything the `session.tabs`
 *  projection publishes, so a repeated same-state ping costs no snapshot rebuild.
 *  Mirrors `retainAgentRowSnapshot`'s change set so both carriers invalidate alike. */
export function createHookStatusSessionTabsInvalidator(): {
  (event: AgentHookEventPayload): boolean
  forgetPane: (paneKey: string) => void
  forgetConnection: (connectionId: string) => string[]
} {
  const known = new Map<string, KnownStatus>()
  const invalidator = (event: AgentHookEventPayload): boolean => {
    // Why: resume-identity rows carry transport placeholders, not status; the
    // provider-session invalidator owns their republish.
    if (event.providerSessionOnly === true) {
      return false
    }
    const previous = known.get(event.paneKey)?.payload
    const next = event.payload
    known.set(event.paneKey, { connectionId: event.connectionId, payload: next })
    return (
      !previous ||
      previous.state !== next.state ||
      previous.prompt !== next.prompt ||
      (previous.agentType ?? null) !== (next.agentType ?? null) ||
      (previous.toolName ?? null) !== (next.toolName ?? null) ||
      (previous.interactivePrompt ?? null) !== (next.interactivePrompt ?? null) ||
      (previous.interrupted ?? false) !== (next.interrupted ?? false)
    )
  }
  // Why: a cleared pane must re-arm, else the memo swallows the first event of the
  // next agent when it happens to match the one that just went away.
  invalidator.forgetPane = (paneKey: string): void => {
    known.delete(paneKey)
  }
  // Why: an SSH disconnect clears a whole host's rows at once and names no pane, so
  // the caller needs the pane list back to republish each affected workspace.
  invalidator.forgetConnection = (connectionId: string): string[] => {
    const forgotten: string[] = []
    for (const [paneKey, status] of known) {
      if (status.connectionId === connectionId) {
        known.delete(paneKey)
        forgotten.push(paneKey)
      }
    }
    return forgotten
  }
  return invalidator
}
