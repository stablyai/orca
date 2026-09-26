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
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

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
  now: () => number
  /** The capsule's single mutation lane, shared with the offer's own operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}) {
  /** The continuation each running resume action sends, by chat. */
  const actions = new Map<string, string>()

  /** The action's own start is the one its continuation is still waiting on. */
  const ownStart = (session: StructuredAgentSessionRestartOfferSession, own: string | undefined) =>
    own !== undefined &&
    session.journal.submissions().find((submission) => submission.dispatchState === 'pending')
      ?.clientMessageId === own

  const movedOn = (marker: AgentSessionResumeMarker): boolean => {
    const session = deps.sessions.get(marker.sessionId)
    if (!session) {
      return false
    }
    const own = actions.get(marker.sessionId)
    const taken = marker.journalCursor
    // An older build's offer recorded no position: only a start withdraws it.
    const accepted =
      taken !== undefined &&
      (session.journal.cursor().epoch !== taken.epoch ||
        session.journal.submissions().some(
          (submission) =>
            submission.clientMessageId !== own &&
            (submission.acceptedSequence ?? 0) > taken.sequence &&
            // A continuation the offer sent that was rejected never reached the agent: a retry
            // sends a new one.
            !(
              submission.dispatchState === 'rejected' &&
              marker.continuations?.includes(submission.clientMessageId)
            )
        ))
    // Proven, not merely spawned: a start that failed during startup never ran the agent.
    const started =
      session.child?.phase === 'ready' ||
      (session.lastEndedChild !== undefined && !session.lastEndedChild.duringStartup)
    return accepted || (started && !ownStart(session, own))
  }

  return {
    movedOn,
    /** A resume action holds the chat from its reservation until it settles. */
    begin: (sessionId: string, continuationId: string): (() => void) => {
      actions.set(sessionId, continuationId)
      return () => {
        if (actions.get(sessionId) === continuationId) {
          actions.delete(sessionId)
        }
      }
    },
    /** The chat's agent proved a start: unless it is a resume action's own, the offer and any
     *  failure record go from the recovery file. Advisory: a failed write is logged, never raised. */
    onAgentStarted: (sessionId: string): void => {
      const session = deps.sessions.get(sessionId)
      const capsule = deps.capsule
      if (!capsule || !session || ownStart(session, actions.get(sessionId))) {
        return
      }
      void deps
        .enqueue(() => capsule.dismiss([sessionId], deps.now()))
        .catch(() => {
          console.warn('[structured-agent-session] withdrawing a restart offer failed')
        })
    }
  }
}
