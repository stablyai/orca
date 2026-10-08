// When a restart offer ends without being acted on: the chat moved on.
//
// One derived fact decides it, for the offer list and for the continuation's own acceptance alike:
// since the offer was taken, another message was accepted in the chat, or its agent proved a start.
// A message is read against the journal position the offer recorded, so the answer survives any
// number of handle closes. A start is known only to the host that saw it, so it is also written
// to the recovery file when it happens. A restored row, a replayed row or a view carries neither,
// so opening a chat withdraws nothing. The rest of a resume action does not count: its own
// continuation, and the start that continuation waits on.

import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { isRestartContinuationOf } from './structured-agent-session-restart-continuation-envelope'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentSessionRestartOfferWithdrawal = ReturnType<
  typeof createStructuredAgentSessionRestartOfferWithdrawal
>

export type StructuredAgentSessionRestartOfferSession = Pick<
  StructuredAgentSessionHostSession,
  'journal' | 'child' | 'lastEndedChild'
>

export function createStructuredAgentSessionRestartOfferWithdrawal(deps: {
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartOfferSession>
  capsule?: Pick<AgentSessionRecoveryCapsule, 'dismiss'>
  logger: StructuredAgentSessionLogger
  now: () => number
  /** The capsule's single mutation lane, shared with the offer's own operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}) {
  const movedOn = (marker: AgentSessionResumeMarker): boolean => {
    const session = deps.sessions.get(marker.sessionId)
    if (!session) {
      return false
    }
    const taken = marker.journalCursor
    // An older build's offer recorded no position: only a start withdraws it.
    const accepted =
      taken !== undefined &&
      (session.journal.cursor().epoch !== taken.epoch ||
        session.journal.submissions().some(
          (submission) =>
            (submission.acceptedSequence ?? 0) > taken.sequence &&
            // The offer's own continuation, still queued or rejected, never reached the agent: a
            // retry sends a new one. One handed over may have, answered or not.
            !(
              (isQueuedAgentJournalSubmission(submission) ||
                submission.dispatchState === 'rejected') &&
              isRestartContinuationOf(marker, submission.clientMessageId)
            )
        ))
    // Proven, not merely spawned: a start that failed during startup never ran the agent. Whose
    // start it was is fixed when it was made, so a continuation rejected since still owns it.
    const started =
      session.child?.phase === 'ready'
        ? session.child
        : session.lastEndedChild?.duringStartup === false
          ? session.lastEndedChild
          : undefined
    return (
      accepted ||
      (started !== undefined &&
        !(started.startedFor !== undefined && isRestartContinuationOf(marker, started.startedFor)))
    )
  }

  return {
    movedOn,
    /** The chat's agent proved a start: the offer and any failure record go from the recovery file,
     *  unless the start was for one of that offer's own continuations. Advisory: a failed write is
     *  logged, never raised. */
    onAgentStarted: (sessionId: string): void => {
      const session = deps.sessions.get(sessionId)
      const capsule = deps.capsule
      if (!capsule || !session) {
        return
      }
      const startedFor = session.child?.startedFor
      void deps
        .enqueue(() =>
          capsule.dismiss([sessionId], deps.now(), (marker) =>
            startedFor === undefined ? false : isRestartContinuationOf(marker, startedFor)
          )
        )
        .catch(() => {
          deps.logger.warn('withdrawing a restart offer failed', {
            scope: 'restart-offer-withdraw',
            sessionId
          })
        })
    }
  }
}
