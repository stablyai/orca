import type { CodexStructuredSessionEvent } from '../codex/codex-structured-session-state'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

/** The Codex adapter events the host's lifecycle handler consumes: every exit, expected or not, and
 *  an end whose close could not prove the exit. */
export function structuredCodexLifecycleEvent(
  event: CodexStructuredSessionEvent
): StructuredAgentSessionLifecycleEvent | null {
  return event.type === 'end-unproven' || (event.type === 'ended' && 'cause' in event)
    ? event
    : null
}
