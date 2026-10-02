import type { CodexStructuredSessionEvent } from '../codex/codex-structured-session-state'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

/** The Codex adapter events the host's lifecycle handler consumes. A requested close's own end is
 *  not one: the stop that asked for it settles it. */
export function structuredCodexLifecycleEvent(
  event: CodexStructuredSessionEvent
): StructuredAgentSessionLifecycleEvent | null {
  if (event.type === 'end-unproven') {
    return event
  }
  return event.type === 'ended' && 'cause' in event && event.cause === 'unexpected-exit'
    ? event
    : null
}
