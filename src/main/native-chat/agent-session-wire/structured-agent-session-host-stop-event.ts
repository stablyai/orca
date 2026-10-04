// The Stop event a host stop writes (`JournalStopEvent`): whether it ends work its event must
// record, and the write itself, issued before the kill.

import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
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

/** How long a host stop waits for the session's sink before it judges whether the stop ends work. */
const STOP_EVENT_DRAIN_TIMEOUT_MS = 1_000

/**
 * Whether this stop ends work its event must record: a running turn or an unanswered send, a start's
 * own included, read once the sink drained what the provider already said. A start that carries
 * no send ends nothing. A person's Stop wrote its own event, and quit, the idle sweep's rest and a
 * retry of a stop already owed write none.
 */
export async function stopEndsWork(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  ending: StructuredAgentSessionStopEnding
): Promise<boolean> {
  const { child, journal } = session
  if ('recorded' in ending || ending.quit || ending.resting || ending.retry || !child) {
    return false
  }
  // A failed drain has nothing more to deliver, so the journal's read as it stands holds. One
  // still running past its bound may hold the turn row of a send already accepted: that reads
  // working.
  const drain = await withTimeout(
    context.runtimeState.flushEventSink(sessionId).then(
      () => 'drained' as const,
      () => 'failed' as const
    ),
    STOP_EVENT_DRAIN_TIMEOUT_MS,
    'slow' as const
  )
  const working =
    (drain === 'slow' && journal.stopMarks.latestAcceptedSendUnopened()) ||
    isStructuredAgentSessionMainAgentWorking(
      journal.activeTurnId(),
      journal.submissions(),
      child.fence
    )
  // A host stop of work a person's Stop is already ending must not supersede that Stop's reason.
  return (
    working &&
    (ending.cause === 'user-close' || !journal.stopMarks.personStopDecides(journal.activeTurnId()))
  )
}

/** Writes this stop's event (`JournalStopEvent`). Issued before the kill and never awaited by it:
 *  bookkeeping, reported on failure. */
export function recordStopEvent(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  ending: StructuredAgentSessionStopEnding
): Promise<void> {
  if ('recorded' in ending) {
    return Promise.resolve()
  }
  const turnId = session.journal.activeTurnId()
  return session.journal
    .appendStopEvent(
      { reason: ending.cause, ...(turnId !== null ? { turnId } : {}) },
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
