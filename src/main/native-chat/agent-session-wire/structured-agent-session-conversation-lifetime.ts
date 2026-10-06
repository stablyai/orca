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
  abandonQueuedStructuredAgentSessionMessages,
  closeStructuredAgentSessionConversationUnderSerialize,
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionCloseCause,
  type StructuredAgentSessionLifetimeContext,
  type StructuredAgentSessionStopEnding
} from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { StructuredAgentSessionIdleSweep } from './structured-agent-session-idle-sweep'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import { deferredStructuredAgentSessionLogger } from './structured-agent-session-logger'

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
  // The owed copy fails as an open does: the reader gets the classified refusal, never its text.
  const whenImported = (sessionId: string, session: StructuredAgentSessionHostSession) =>
    session.journal.whenImported().catch((error: unknown) => {
      throw readRefusals.refusal(sessionId, error)
    })
  const stopAgent = (sessionId: string, ending: StructuredAgentSessionStopEnding) =>
    stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, ending)

  const closeConversation = async (sessionId: string): Promise<boolean> => {
    // The handle carries the proof that releases a lease its child's wind-down could not.
    if (await releaseLeaseOfEndedStructuredAgentSessionChild(host.context(), sessionId)) {
      return false
    }
    return closeStructuredAgentSessionConversationUnderSerialize(
      {
        sessions,
        closeStatus: (id) => {
          const tabs = deps().store.getVisibleSessionTabIndex()
          // A legacy store cannot say, so the row stays; restart is the boundary that forgets.
          host.closeStatus(id, { listed: !tabs.present || tabs.sessionIds.includes(id) })
        }
      },
      sessionId
    )
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
    // A host stop: the delivery loop waiting on this child records the failed start on the message
    // it was for, worded from the hostStopped fact.
    stopStartingAgent: (sessionId) =>
      stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, {
        cause: 'host-stop'
      }),
    closeConversation,
    logger: deps().logger,
    ...deps().idleSweep
  })

  return {
    idleSweep,
    stopAgent,
    /** Quit has begun: nothing opens a conversation or sweeps one after this. */
    dispose: (): void => {
      disposed = true
      idleSweep.dispose()
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
        // Restore left its per-chat file uncopied; a reader gets the chat from the one database.
        // Awaited only then: an open conversation otherwise answers in the same turn.
        if (open.journal.importPending) {
          await whenImported(sessionId, open)
        }
        readRefusals.forget(sessionId)
        return open
      }
      const record = deps().store.getRecord(sessionId)
      if (!record) {
        throw agentSessionRefusalError('agent_session_identity_required', {
          reason: 'recordMissing'
        })
      }
      if (!adapterSupportsRecord(deps().adapter, record)) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'hostUnsupported'
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
        // Restore may have opened it while this waited.
        if (session.journal.importPending) {
          await whenImported(sessionId, session)
        }
        readRefusals.forget(sessionId)
        return session
      })
    },
    /** Ends a chat's resources, not the chat: its record and journal stay on disk, and what is
     *  still queued will not be sent. */
    close: (sessionId: string, cause: StructuredAgentSessionCloseCause): Promise<void> =>
      serialize(sessionId, async () => {
        readRefusals.forget(sessionId)
        const session = sessions.get(sessionId)
        if (session) {
          // Abandoned before the stop, so no start delivers it.
          await abandonQueuedStructuredAgentSessionMessages(deps(), sessionId, session.journal)
        }
        await stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, { cause })
        await closeConversation(sessionId)
      })
  }
}
