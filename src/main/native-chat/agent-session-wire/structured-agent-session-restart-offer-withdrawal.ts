// Compare accepted messages to the saved cursor across handle closes; persist independent proven starts.
// Reads/replays and the offer’s own continuation/start never withdraw it.

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
  'journal' | 'child' | 'lastEndedChild' | 'restartResume'
>

export function createStructuredAgentSessionRestartOfferWithdrawal(deps: {
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartOfferSession>
  capsule?: Pick<AgentSessionRecoveryCapsule, 'dismiss'>
  logger: StructuredAgentSessionLogger
  now: () => number
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}) {
  const movedOn = (marker: AgentSessionResumeMarker): boolean => {
    const session = deps.sessions.get(marker.sessionId)
    if (!session) {
      return false
    }
    const taken = marker.journalCursor
    // Legacy offers lack cursors, so only proven startup can withdraw them.
    const accepted =
      taken !== undefined &&
      (session.journal.cursor().epoch !== taken.epoch ||
        session.journal.submissions().some(
          (submission) =>
            (submission.acceptedSequence ?? 0) > taken.sequence &&
            // Own queued/rejected continuations allow retry; handover may have delivered despite no answer.
            !(
              (isQueuedAgentJournalSubmission(submission) ||
                submission.dispatchState === 'rejected') &&
              isRestartContinuationOf(marker, submission.clientMessageId)
            )
        ))
    // Require proven startup and its immutable opening-send identity, even after rejection.
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
    /** Retire offer/failure after independent proven startup; failures log without blocking. */
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
