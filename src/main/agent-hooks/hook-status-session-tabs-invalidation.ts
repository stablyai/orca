import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'

type KnownStatus = {
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  restoredUnconfirmed: boolean
  terminalHandle: string | null
}

/** Reports whether a hook status event changed anything the `session.tabs`
 *  projection publishes, so a repeated same-state ping costs no snapshot rebuild.
 *  This is the whole change set: the runtime's own retained-row comparator (whose boolean
 *  return drove the same republish) was deleted in favour of it. */
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
    const previous = known.get(event.paneKey)
    const next = event.payload
    const restoredUnconfirmed = event.restoredUnconfirmed === true
    known.set(event.paneKey, {
      connectionId: event.connectionId,
      payload: next,
      restoredUnconfirmed,
      terminalHandle: event.terminalHandle ?? null
    })
    return (
      !previous ||
      previous.payload.state !== next.state ||
      previous.payload.workingMode !== next.workingMode ||
      previous.payload.prompt !== next.prompt ||
      (previous.payload.agentType ?? null) !== (next.agentType ?? null) ||
      (previous.payload.toolName ?? null) !== (next.toolName ?? null) ||
      (previous.payload.interactivePrompt ?? null) !== (next.interactivePrompt ?? null) ||
      (previous.payload.interrupted ?? false) !== (next.interrupted ?? false) ||
      (previous.payload.turnCompletedAt ?? null) !== (next.turnCompletedAt ?? null) ||
      (previous.payload.lastAssistantMessage ?? null) !== (next.lastAssistantMessage ?? null) ||
      previous.restoredUnconfirmed !== restoredUnconfirmed ||
      previous.terminalHandle !== (event.terminalHandle ?? null)
    )
  }
  // Why: a cleared pane must re-arm, else the memo swallows the first event of the
  // next agent when it happens to match the one that just went away.
  invalidator.forgetPane = (paneKey: string): void => {
    known.delete(paneKey)
  }
  // Why: an explicit connection clear names no pane, so the caller needs the pane list
  // back to republish each affected workspace.
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
