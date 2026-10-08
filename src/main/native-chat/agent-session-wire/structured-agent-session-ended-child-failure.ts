// Why a queued message the child never took is rejected, by how that child ended.

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

// Every end cause, so a new one does not compile until it says whether it fails what is queued.
const ENDED_CHILD_FAILURE = {
  'user-stop': () => null,
  // The user closing this chat closes what was queued before it; see `closeWhatTheUserClosed`.
  'user-close': () => null,
  // The host stopping the child is Orca's cause, never the provider's: a start that never finished.
  'host-stop': () => ({ failure: agentSessionFailureFact('hostStopped') }),
  exit: providerEndFailure,
  // The attach records its own fault as the end's failure.
  'attach-failed': providerEndFailure,
  // Reached only when an eviction's stop landed and a later step failed, leaving the conversation.
  evict: providerEndFailure
} satisfies Record<
  StructuredAgentSessionChildEndCause,
  (ended: StructuredAgentSessionEndedChild) => StructuredAgentSessionStartFailureCause | null
>

/** Why a queued message the child never took is rejected; null when its end fails nothing. */
export function structuredAgentSessionEndedChildFailure(
  ended: StructuredAgentSessionEndedChild
): StructuredAgentSessionStartFailureCause | null {
  return ENDED_CHILD_FAILURE[ended.cause](ended)
}
