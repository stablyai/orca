// What a provider child's end means for the queued message it was started for: a failed start that
// message takes, or nothing. Read from the child records and the journal each step, never latched.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionStartFailureCause } from './structured-agent-session-failure-text'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionEndedChild,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { failedProviderChildStart } from './structured-agent-session-provider-child'
import {
  isStillQueued,
  rejectedAsFailedStartAt
} from './structured-agent-session-start-failure-settlement'

/** A start that died between steps fails the message it was for, while that message is still
 *  queued: once it is rejected nothing matches, so the next message starts afresh. A view's start
 *  was for no message and fails none. */
export function startThatFailedWhileQueued(
  session: StructuredAgentSessionHostSession
): { cause: StructuredAgentSessionStartFailureCause; clientMessageId: string } | null {
  const ended = failedProviderChildStart(session)
  const startedFor = ended?.startedFor
  if (!ended || startedFor === undefined || !isStillQueued(session.journal, startedFor)) {
    return null
  }
  const cause = structuredAgentSessionEndedChildFailure(ended)
  return cause ? { cause, clientMessageId: startedFor } : null
}

/** A child still starting whose start a message was already rejected for: read from the journal,
 *  so no flag can outlive it. Ended before the next message's start rather than at once, so an exit
 *  of its own, already on its way, settles it first. One a stop is closing is that stop's. */
export function childWhoseStartFailed(session: StructuredAgentSessionHostSession): boolean {
  const child = session.child
  if (!child || child.phase !== 'starting' || child.close) {
    return false
  }
  return session.journal
    .submissions()
    .some((submission) => rejectedAsFailedStartAt(submission, child.fence))
}

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
