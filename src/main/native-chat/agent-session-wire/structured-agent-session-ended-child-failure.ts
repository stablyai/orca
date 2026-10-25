import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionStartFailureCause } from './structured-agent-session-failure-text'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionEndedChild
} from './structured-agent-session-host-types'

function providerEndFailure(
  ended: StructuredAgentSessionEndedChild
): StructuredAgentSessionStartFailureCause {
  if (ended.duringStartup) {
    return { exit: ended.failure }
  }
  return { failure: ended.failure ?? agentSessionFailureFact('providerExited') }
}

// Exhaust causes so newly added ends must classify queued-send failure.
const ENDED_CHILD_FAILURE = {
  'user-stop': () => null,
  'user-close': () => null,
  'context-clear': () => null,
  // Host Stop is Orca’s action, not a provider failure.
  'host-stop': (ended) => ({ failure: ended.failure ?? agentSessionFailureFact('hostStopped') }),
  exit: providerEndFailure,
  'attach-failed': providerEndFailure,
  // Partial eviction failed after child shutdown but left the conversation open.
  evict: providerEndFailure
} satisfies Record<
  StructuredAgentSessionChildEndCause,
  (ended: StructuredAgentSessionEndedChild) => StructuredAgentSessionStartFailureCause | null
>

/** Null means this child end fails no queued work. */
export function structuredAgentSessionEndedChildFailure(
  ended: StructuredAgentSessionEndedChild
): StructuredAgentSessionStartFailureCause | null {
  return ENDED_CHILD_FAILURE[ended.cause](ended)
}
