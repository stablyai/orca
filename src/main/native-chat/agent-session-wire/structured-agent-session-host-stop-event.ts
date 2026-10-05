// The Stop event a host stop writes (`JournalStopEvent`): whether it ends work its event must
// record, and the write itself, issued before the kill.

import { hasUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-unanswered-dispatch'
import type { StructuredAgentSessionStopCause } from './structured-agent-session-adapter'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** How a stop ends the child, and why (`lastEndedChild`). A person's Stop wrote its event in its
 *  own step (`recorded` names its reason); any other stop names the reason its event records, with
 *  the host's text for it. Quit writes none: its resume marker's trigger records why. */
export type StructuredAgentSessionStopEnding = (
  | { recorded: 'user-stop' }
  | {
      cause: Exclude<StructuredAgentSessionStopCause, 'user-stop'>
      reason?: string
      quit?: true
      /** The idle sweep judged the agent resting (`owesWork`): a send it retires unanswered is
       *  no work its event records. */
      resting?: true
    }
) & {
  /** The retry of a stop already owed, set only by that retry: its event, if any, is written. */
  retry?: true
}

/** The work a host stop ends, as its event records it: why, and the turn it cuts (none for a send). */
export type StructuredAgentSessionStoppedWork = {
  reason: Exclude<StructuredAgentSessionStopCause, 'user-stop'>
  turnId: string | null
}

/**
 * The work this stop ends, which its event must record, read from the host's live view in this
 * serialized step, with no wait: a turn or send the provider's child has in flight, or a send the
 * journal holds unanswered, a start's own included. Null when it ends none: a start that carries no
 * send, or work a person's Stop is already ending. A person's Stop wrote its own event, and quit,
 * the idle sweep's rest and a retry of a stop already owed write none.
 */
export function workStopEnds(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  ending: StructuredAgentSessionStopEnding
): StructuredAgentSessionStoppedWork | null {
  const { child, journal } = session
  if ('recorded' in ending || ending.quit || ending.resting || ending.retry || !child) {
    return null
  }
  const { adapter } = context.deps
  const journalTurnId = journal.activeTurnId()
  // The child's frames lead the rows they become; a provider with no live view has only the rows.
  const live = adapter.liveWork
    ? adapter.liveWork(sessionId)
    : journalTurnId === null
      ? undefined
      : { turnId: journalTurnId }
  if (
    live === undefined &&
    !hasUnansweredStructuredAgentSessionDispatch(journal.submissions(), child.fence)
  ) {
    return null
  }
  // A host stop of work a person's Stop is already ending must not supersede that Stop's reason.
  if (ending.cause !== 'user-close' && journal.stopMarks.personStopDecides(journalTurnId)) {
    return null
  }
  return { reason: ending.cause, turnId: journalTurnId ?? live?.turnId ?? null }
}

/** Writes this stop's event (`JournalStopEvent`). Issued before the kill and never awaited by it:
 *  bookkeeping, reported on failure. */
export function recordStopEvent(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  { reason, turnId }: StructuredAgentSessionStoppedWork
): Promise<void> {
  return session.journal
    .appendStopEvent(
      { reason, ...(turnId !== null ? { turnId } : {}) },
      structuredAgentSessionConversationFence(context.deps.store, sessionId)
    )
    .then(
      () => undefined,
      (error: unknown) =>
        context.deps.logger.warn("a host stop's Stop event row skipped", {
          scope: 'stop-event',
          sessionId,
          error
        })
    )
}
