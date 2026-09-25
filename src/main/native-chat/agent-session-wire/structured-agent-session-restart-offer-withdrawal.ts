// When a restart offer ends without being acted on: the chat moved on.
//
// One derived fact decides it, for the offer list and for the continuation's own acceptance alike:
// since the restart, another message was accepted in the chat, or its agent proved a start. Both
// are read off what the conversation's open handle holds, which the restart closed — a restored
// row, a replayed row or a view carries neither, so opening a chat withdraws nothing. The rest of
// a resume action does not count: its own continuation, and the start that continuation waits on.
//
// The handle is only a cache, so its answer does not outlive a close: each time the fact may have
// changed — a message accepted, a start proven — the offer is retired durably too.

import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
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
  /** Whether this message was a restart continuation, by who sent it. */
  isContinuation: (clientMessageId: string) => boolean
  now: () => number
  /** The capsule's single mutation lane, shared with the offer's own operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}) {
  /** The continuation each running resume action sends, by chat. */
  const actions = new Map<string, string>()

  const movedOn = (sessionId: string): boolean => {
    const session = deps.sessions.get(sessionId)
    if (!session) {
      return false
    }
    const own = actions.get(sessionId)
    const submissions = session.journal.submissions()
    const accepted = submissions.some(
      (submission) =>
        submission.clientMessageId !== own &&
        !session.journal.wroteBeforeOpen(submission.acceptedSequence) &&
        // A continuation that was rejected never reached the agent: a retry sends a new one.
        !(
          submission.dispatchState === 'rejected' && deps.isContinuation(submission.clientMessageId)
        )
    )
    if (accepted) {
      return true
    }
    // Proven, not merely spawned: a start that failed during startup never ran the agent.
    const started =
      session.child?.phase === 'ready' ||
      (session.lastEndedChild !== undefined && !session.lastEndedChild.duringStartup)
    // The action's own start is the one its continuation is still waiting on.
    const ownStart =
      own !== undefined &&
      submissions.find((submission) => submission.dispatchState === 'pending')?.clientMessageId ===
        own
    return started && !ownStart
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
    /** The fact may have changed: retire the offer and any failure record durably if it holds.
     *  Advisory: a failed write is logged, never raised. */
    recheck: (sessionId: string): void => {
      const capsule = deps.capsule
      if (!capsule || !movedOn(sessionId)) {
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
