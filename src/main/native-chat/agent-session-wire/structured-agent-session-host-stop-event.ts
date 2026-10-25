import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { heldStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { StructuredAgentSessionStopCause } from './structured-agent-session-adapter'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { JournalStopSettle } from '../agent-session-journal/queued-message-pause'
import { sentSinceStop } from './structured-agent-session-queued-stop'
import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'

/** Personal Stop already records its event; other host stops record cause, while quit uses cut-turn rows. */
export type StructuredAgentSessionStopEnding =
  | { recorded: 'user-stop' }
  | {
      cause: Exclude<StructuredAgentSessionStopCause, 'user-stop'>
      reason?: string
      failure?: SubmissionRejectionFact
      quit?: AgentSessionResumeTrigger
      /** Idle retirement of unanswered sends records no active-work Stop. */
      resting?: true
    }

const STOP_EVENT_DRAIN_TIMEOUT_MS = 1_000

/** Drain provider evidence before deciding whether work ended; skip recorded/personal, quit, resting and joined closes. */
export async function stopEndsWork(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  ending: StructuredAgentSessionStopEnding
): Promise<boolean> {
  const { child, journal } = session
  if (
    'recorded' in ending ||
    ending.quit ||
    ending.resting ||
    ending.cause === 'context-clear' ||
    !child
  ) {
    return false
  }
  // Failed drains leave current state authoritative; timed-out drains may still owe an accepted turn row.
  const drain = await withTimeout(
    context.runtimeState.flushEventSink(sessionId).then(
      () => 'drained' as const,
      () => 'failed' as const
    ),
    STOP_EVENT_DRAIN_TIMEOUT_MS,
    'slow' as const
  )
  const work = heldStructuredAgentSessionCurrentWork(
    context.deps.store,
    sessionId,
    journal,
    session
  )
  const working =
    (drain === 'slow' && journal.stopMarks.latestAcceptedSendUnopened()) || work.working()
  return working && (ending.cause === 'user-close' || !defersToPersonsStop(session, work))
}

/** Host Stops must not overwrite personal cancellation or lift its still-active queue pause. */
function defersToPersonsStop(
  session: StructuredAgentSessionHostSession,
  work: StructuredAgentSessionCurrentWork
): boolean {
  const { journal } = session
  const live = work.activeTurnId()
  if (live !== null) {
    return journal.stopMarks.personStopDecides(live)
  }
  const inForce = journal.queuedMessages.userStopInForce()
  return (
    (inForce !== null && !sentSinceStop(journal, inForce)) ||
    journal.stopMarks.personStopDecides(null)
  )
}

/** Issue before kill without awaiting persistence; unnamed user-close binds until the caller settles it. */
export function recordStopEvent(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  ending: StructuredAgentSessionStopEnding
): Promise<JournalStopSettle | null> {
  if ('recorded' in ending) {
    return Promise.resolve(null)
  }
  const fence = structuredAgentSessionConversationFence(context.deps.store, sessionId)
  const turnId = heldStructuredAgentSessionCurrentWork(
    context.deps.store,
    sessionId,
    session.journal,
    session
  ).activeTurnId()
  return session.journal
    .appendStopEvent({ reason: ending.cause, ...(turnId !== null ? { turnId } : {}) }, fence)
    .then(
      () => (ending.cause === 'user-close' ? session.journal.stopMarks.beginSettle() : null),
      (error: unknown) => {
        context.deps.logger.warn("a host stop's Stop event row skipped", {
          scope: 'stop-event',
          sessionId,
          error
        })
        return null
      }
    )
}
