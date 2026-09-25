// When a restart offer ends without being acted on: the chat's agent was started again.
//
// The fact is the one the agent-status store already carries — a chat is host-owned exactly while
// its agent runs — read at its not-owned → owned edge. Restored and replayed rows carry no running
// agent, and opening a chat starts none, so only a real start withdraws. A resume action's own
// start does not; any other start during that action withdraws the offer and refuses the action.
// Two acts racing to be first — a message and a continuation — are decided at acceptance instead:
// the first one accepted since the restart wins.

import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionRestartOfferWithdrawal = ReturnType<
  typeof createStructuredAgentSessionRestartOfferWithdrawal
>

export function createStructuredAgentSessionRestartOfferWithdrawal(deps: {
  sessions: ReadonlyMap<string, { journal: AgentSessionJournal }>
  capsule?: Pick<AgentSessionRecoveryCapsule, 'dismiss'>
  /** Quit has begun: a start that lands now must not touch the offers teardown is capturing. */
  isDisposed: () => boolean
  /** Whether this message was a restart continuation, by who sent it. */
  isContinuation: (clientMessageId: string) => boolean
  now: () => number
  /** The capsule's single mutation lane, shared with the offer's own operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}) {
  const actions = new Map<string, { continuationId: string; withdrawn: boolean }>()

  /** The offer and any failure record go. Advisory: a failed write is logged, never raised. */
  const retire = (sessionId: string): void => {
    const capsule = deps.capsule
    if (!capsule) {
      return
    }
    void deps
      .enqueue(() => capsule.dismiss([sessionId], deps.now()))
      .catch(() => {
        console.warn('[structured-agent-session] withdrawing a restart offer failed')
      })
  }

  return {
    /** A resume action holds the chat from its reservation until it settles. */
    begin: (sessionId: string, continuationId: string): (() => void) => {
      const action = { continuationId, withdrawn: false }
      actions.set(sessionId, action)
      return () => {
        if (actions.get(sessionId) === action) {
          actions.delete(sessionId)
        }
      }
    },
    /** Another start withdrew the offer while an action held it. */
    withdrawn: (sessionId: string): boolean => actions.get(sessionId)?.withdrawn === true,
    /** A message was accepted since the restart: by this conversation's open handle, which the
     *  restart closed. A continuation that was rejected never reached the agent, so it does not
     *  count: a retry sends a new one. */
    acceptedSinceRestart: (sessionId: string): boolean => {
      const journal = deps.sessions.get(sessionId)?.journal
      return (journal?.submissions() ?? []).some(
        (submission) =>
          !journal?.wroteBeforeOpen(submission.acceptedSequence) &&
          !(
            submission.dispatchState === 'rejected' &&
            deps.isContinuation(submission.clientMessageId)
          )
      )
    },
    onOwnedEdge: (sessionId: string): void => {
      if (deps.isDisposed()) {
        return
      }
      const action = actions.get(sessionId)
      if (action) {
        // The action's own start is the one whose oldest undelivered message is its continuation.
        const oldest = deps.sessions
          .get(sessionId)
          ?.journal.submissions()
          .find((submission) => submission.dispatchState === 'pending')
        if (oldest?.clientMessageId === action.continuationId) {
          return
        }
        action.withdrawn = true
      }
      retire(sessionId)
    }
  }
}
