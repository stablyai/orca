// How a conversation is reached, closed and swept — the host's lifetime rules in one place.
//
// A conversation is reached only through `conversation`, which opens it at rest and starts no
// agent. It closes when its tab closes or the idle sweep finds its handle is only a cache. Every
// public entry point here takes the session's serialize once and calls the under-serialize forms,
// because the queue is not reentrant.

import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { createJournalOpenReadRefusals } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import { releaseLeaseOfEndedStructuredAgentSessionChild } from './structured-agent-session-child-close'
import {
  holdClosedStructuredAgentSessionSends,
  closeStructuredAgentSessionConversationUnderSerialize,
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionCloseCause,
  type StructuredAgentSessionLifetimeContext,
  type StructuredAgentSessionStopEnding
} from './structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import { StructuredAgentSessionIdleSweep } from './structured-agent-session-idle-sweep'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { deferredStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { sameProviderChild } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionExpiredStartup } from './structured-agent-session-startup-attempt'

export type StructuredAgentSessionConversationLifetime = ReturnType<
  typeof createStructuredAgentSessionConversationLifetime
>

export function createStructuredAgentSessionConversationLifetime(host: {
  /** Resolved per call: the host's collaborators are assigned after this is built. */
  context: () => StructuredAgentSessionLifetimeContext
  sessions: StructuredAgentSessionConversations
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** PR 1's one open function, for a caller inside the session's serialize. */
  open: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  deliveryActive: (sessionId: string) => boolean
  /** The handle closed: `listed` keeps the chat's row in the agent-status store for its tab. */
  closeStatus: (sessionId: string, options: { listed: boolean }) => void
  /** The session's child records, the host's one read of them. */
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
}) {
  let disposed = false
  const { sessions, serialize } = host
  const deps = () => host.context().deps
  const readRefusals = createJournalOpenReadRefusals(
    deferredStructuredAgentSessionLogger(() => deps().logger)
  )
  const stopAgent = (sessionId: string, ending: StructuredAgentSessionStopEnding) =>
    stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, ending)

  const closeConversation = async (sessionId: string, atRest = false): Promise<boolean> => {
    // The handle carries the proof that releases a lease its child's wind-down could not.
    if (await releaseLeaseOfEndedStructuredAgentSessionChild(host.context(), sessionId)) {
      return false
    }
    const closed = await closeStructuredAgentSessionConversationUnderSerialize(
      {
        sessions,
        closeStatus: (id) => {
          const tabs = deps().store.getVisibleSessionTabIndex()
          // A legacy store cannot say, so the row stays; restart is the boundary that forgets.
          host.closeStatus(id, { listed: !tabs.present || tabs.sessionIds.includes(id) })
        }
      },
      sessionId,
      atRest
    )
    if (closed) {
      host.context().runtimeState.optionRevisions.forget(sessionId)
    }
    return closed
  }

  const idleSweep = new StructuredAgentSessionIdleSweep({
    sessions,
    serialize,
    now: () => host.context().now(),
    isDisposed: () => disposed,
    deliveryActive: host.deliveryActive,
    childWork: host.readChildWork,
    hasOpenDispatch: (sessionId) => {
      const record = deps().store.getRecord(sessionId)
      return record !== null && deps().hasOpenDispatch?.(record) === true
    },
    providerHoldsDispatch: (sessionId) => deps().adapter.holdsDispatch?.(sessionId) === true,
    // The host puts an idle agent to rest: a turn it cuts short is news, not the user's Stop.
    stopAgent: (sessionId) => stopAgent(sessionId, { cause: 'evict', resting: true }),
    // A host stop: the child's end rejects what it was handed and writes the one error row, and
    // the delivery loop rejects what is still queued under the same row, all worded from the
    // hostStopped fact.
    stopStartingAgent: (sessionId) =>
      stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, {
        cause: 'host-stop'
      }),
    closeConversation: (sessionId) => closeConversation(sessionId, true),
    logger: deps().logger,
    ...deps().idleSweep
  })

  const stopStartingChild = (
    sessionId: string,
    expired: StructuredAgentSessionProviderChildIdentity | null
  ): void => {
    void serialize(sessionId, async () => {
      const child = sessions.get(sessionId)?.child
      if (!expired || !child || child.phase !== 'starting' || !sameProviderChild(child, expired)) {
        return
      }
      await stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, {
        cause: 'host-stop'
      })
    }).catch((error: unknown) =>
      deps().logger.warn('stopping an agent that could not finish starting failed', {
        scope: 'startup-limit',
        sessionId,
        error
      })
    )
  }
  return {
    idleSweep,
    stopAgent,
    /** A host stop of the child the expired attempt published, if it is still that one and still
     *  starting: its end fails what is queued, as the idle sweep's stop of a start does. */
    expireStartup: ({ sessionId, child }: StructuredAgentSessionExpiredStartup): void =>
      stopStartingChild(sessionId, child),
    /** A start that cannot finish ends as one past its limit does, outside the caller's step. */
    stopStartingChild,
    /** Quit has begun: nothing opens a conversation or sweeps one after this. */
    dispose: (): void => {
      disposed = true
      idleSweep.dispose()
      host.context().runtimeState.startupAttempts.dispose()
    },
    /**
     * The only way any code reaches a session. An open conversation answers without the lock, so
     * a read never waits behind a start; a closed one is opened once, under it. Nothing here
     * touches the lease or starts a child. Use the result before the next `await`: a close can
     * drop it after.
     */
    conversation: async (sessionId: string): Promise<StructuredAgentSessionHostSession> => {
      const open = sessions.get(sessionId)
      if (open) {
        readRefusals.forget(sessionId)
        return open
      }
      const record = deps().store.getRecord(sessionId)
      if (!record) {
        throw agentSessionRefusalError('agent_session_identity_required', {
          reason: 'recordMissing'
        })
      }
      return serialize(sessionId, async () => {
        // Read at the open itself: a read queued before quit began runs after it.
        if (disposed) {
          throw new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED)
        }
        const session = await host.open(sessionId).catch((error: unknown) => {
          throw readRefusals.refusal(sessionId, error)
        })
        if (!session) {
          throw agentSessionRefusalError('agent_session_identity_required', {
            reason: 'recordMissing'
          })
        }
        readRefusals.forget(sessionId)
        return session
      })
    },
    /** Ends a chat's resources, not the chat: its record and journal stay on disk, and what is
     *  still queued waits for the chat's next turn; a person's unsent message stays as a card. */
    close: (sessionId: string, cause: StructuredAgentSessionCloseCause): Promise<void> => {
      // Outside the queue: a start the provider never answers must not hold the close behind it.
      host.context().runtimeState.acquireAborts.abort(sessionId, 'closed while starting')
      return serialize(sessionId, async () => {
        readRefusals.forget(sessionId)
        const session = sessions.get(sessionId)
        if (session) {
          // Settled and marked before the stop, so no start delivers it, and nothing it closed with
          // sends by itself, even if the handle stays open.
          await holdClosedStructuredAgentSessionSends(deps(), sessionId, session.journal, {
            mark: 'always'
          })
        }
        await stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, { cause })
        await closeConversation(sessionId)
      })
    }
  }
}
