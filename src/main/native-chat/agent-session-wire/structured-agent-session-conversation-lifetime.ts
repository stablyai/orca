// How a conversation is reached, closed and swept — the host's lifetime rules in one place.
//
// A conversation is reached only through `conversation`, which opens it at rest and starts no
// agent. It closes when its tab closes or the idle sweep finds its handle is only a cache. Every
// public entry point here takes the session's serialize once and calls the under-serialize forms,
// because the queue is not reentrant.

import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import {
  abandonQueuedStructuredAgentSessionMessages,
  closeStructuredAgentSessionConversationUnderSerialize,
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { StructuredAgentSessionIdleSweep } from './structured-agent-session-idle-sweep'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'

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
}) {
  let disposed = false
  const { sessions, serialize } = host
  const deps = () => host.context().deps
  // The sweep's stop puts an idle agent to rest: nothing is queued, so no loop reads its cause.
  const stopAgent = (sessionId: string) =>
    stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId)

  const closeConversation = (sessionId: string): Promise<boolean> =>
    closeStructuredAgentSessionConversationUnderSerialize(
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

  const idleSweep = new StructuredAgentSessionIdleSweep({
    sessions,
    serialize,
    now: () => host.context().now(),
    isDisposed: () => disposed,
    deliveryActive: host.deliveryActive,
    backgroundTaskState: (sessionId) => deps().adapter.backgroundTaskState?.(sessionId),
    hasOpenDispatch: (sessionId) => {
      const record = deps().store.getRecord(sessionId)
      return record !== null && deps().hasOpenDispatch?.(record) === true
    },
    stopAgent,
    // A host stop with its reason: the delivery loop waiting on this child writes the one error
    // row and rejects what is queued with it.
    stopStartingAgent: (sessionId) =>
      stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, {
        cause: 'host-stop',
        reason: `${TUI_AGENT_DISPLAY_NAMES[sessions.get(sessionId)?.params.provider ?? 'claude']} never finished starting, so Orca stopped it.`
      }),
    closeConversation,
    onError: (sessionId, error) => deps().onEventSinkError?.({ sessionId, error }),
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
        return open
      }
      if (disposed) {
        throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
      }
      const record = deps().store.getRecord(sessionId)
      if (!record) {
        throw new Error('agent_session_identity_required')
      }
      if (!adapterSupportsRecord(deps().adapter, record)) {
        throw new Error('structured_agent_session_unsupported')
      }
      return serialize(sessionId, async () => {
        const session = await host.open(sessionId)
        if (!session) {
          throw new Error('agent_session_identity_required')
        }
        return session
      })
    },
    /** Ends a chat's resources, not the chat: its record and journal stay on disk, and what is
     *  still queued will not be sent. */
    close: (sessionId: string): Promise<void> =>
      serialize(sessionId, async () => {
        const session = sessions.get(sessionId)
        if (session) {
          // Abandoned before the stop, so no start delivers it.
          await abandonQueuedStructuredAgentSessionMessages(deps(), sessionId, session.journal)
        }
        await stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, {
          cause: 'evict'
        })
        await closeConversation(sessionId)
      })
  }
}
