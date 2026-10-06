// What a provider child's end means for the messages it was for, by the cause of the end: a failed
// start they take, a close of the chat that closes them, or nothing.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionStartFailureCause } from './structured-agent-session-failure-text'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionEndedChild,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { failedProviderChildStart } from './structured-agent-session-provider-child'
import { submissionsHandedToChild } from './structured-agent-session-start-attempt-failure'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** A start that died while nothing recorded it — its exit landed between steps, say: the message
 *  that waited on it, and any its child was handed, take its failure rather than starting again. */
export function startThatFailedUnrecorded(
  session: StructuredAgentSessionHostSession,
  next: AgentJournalSubmission | undefined
): {
  cause: StructuredAgentSessionStartFailureCause
  waiting: string[]
  ended: StructuredAgentSessionEndedChild
} | null {
  const ended = failedProviderChildStart(session)
  const cause = ended ? structuredAgentSessionEndedChildFailure(ended) : null
  if (!ended || !cause) {
    return null
  }
  const waitedOnIt =
    next?.acceptedSequence !== undefined &&
    ended.endedAt.epoch === session.journal.cursor().epoch &&
    ended.endedAt.sequence >= next.acceptedSequence
  const waiting = [
    ...(waitedOnIt ? [next.clientMessageId] : []),
    ...submissionsHandedToChild(session.journal, ended.fence)
  ]
  return waiting.length > 0 ? { cause, waiting, ended } : null
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

/** A child whose start the loop already recorded as failed, still indexed until its end lands:
 *  `end` it when a message is ready to go, so that message has a fresh start; `wait` for its end
 *  otherwise; null when there is no such child, or a stop is already closing it: the next start
 *  joins that close, and is refused while it cannot prove the exit. */
export function childWhoseStartFailed(
  session: StructuredAgentSessionHostSession,
  next: AgentJournalSubmission | undefined
): 'wait' | 'end' | null {
  if (!session.child?.startFailed) {
    return null
  }
  if (!next) {
    return 'wait'
  }
  return session.child.close ? null : 'end'
}

/** Ends a child whose start failed. A stop that could not prove the exit leaves the child closing,
 *  which the next start joins as for any such stop; it is not the message's failure. */
export async function endChildWhoseStartFailed(
  session: StructuredAgentSessionHostSession,
  sessionId: string,
  deps: {
    endFailedStart: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<'continue'> {
  try {
    await deps.endFailedStart(sessionId)
  } catch (error) {
    if (!session.child?.close) {
      throw error
    }
    deps.logger.warn('ending a failed start left its child closing', {
      scope: 'delivery-loop-end-failed-start',
      sessionId,
      error
    })
  }
  return 'continue'
}

/** A close of this chat that stopped its child and then did not complete still closed what was
 *  queued before it, so no child starts for those. Ordered, not latched: a later send goes on.
 *  False when those could not be closed. */
export async function closeWhatTheUserClosed(
  session: StructuredAgentSessionHostSession,
  abandonQueued: (which: (submission: AgentJournalSubmission) => boolean) => Promise<boolean>
): Promise<boolean> {
  const ended = session.lastEndedChild
  if (session.child || ended?.cause !== 'user-close') {
    return true
  }
  const { epoch } = session.journal.cursor()
  return abandonQueued(
    (submission) =>
      ended.endedAt.epoch === epoch &&
      submission.acceptedSequence !== undefined &&
      submission.acceptedSequence <= ended.endedAt.sequence
  )
}
