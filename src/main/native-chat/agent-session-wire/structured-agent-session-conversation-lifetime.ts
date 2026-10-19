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
import type { ExecutionHostId } from '../../../shared/execution-host'
import { stopWorkspaceSleepChat } from './structured-agent-session-workspace-sleep-stop'
import type { StructuredAgentSessionExpiredStartup } from './structured-agent-session-startup-attempt'
import {
  providerStartupFailureFact,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'
import { recordStructuredAgentSessionStartFailure } from './structured-agent-session-start-failure-row'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'

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
  /** Child work the provider reported running and not over, recorded or not. */
  childWorkOpen: (sessionId: string) => boolean
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
    return closed
  }

  const hasOpenDispatch = (sessionId: string): boolean => {
    const record = deps().store.getRecord(sessionId)
    return record !== null && deps().hasOpenDispatch?.(record) === true
  }
  const providerHoldsDispatch = (sessionId: string): boolean =>
    deps().adapter.holdsDispatch?.(sessionId) === true

  const holdStopClose = async <T>(
    sessionId: string,
    stop: () => Promise<T>,
    onCloseError?: (error: unknown) => void
  ): Promise<T> => {
    const session = sessions.get(sessionId)
    if (session) {
      await holdClosedStructuredAgentSessionSends(deps(), sessionId, session.journal, {
        mark: 'always'
      })
    }
    const result = await stop()
    try {
      await closeConversation(sessionId)
    } catch (error) {
      if (!onCloseError) {
        throw error
      }
      onCloseError(error)
    }
    return result
  }

  const closeForWorkspaceSleep = (
    sessionId: string,
    workspaceId: string,
    executionHostId: ExecutionHostId
  ): Promise<{ fence: number; stopped: boolean } | null> => {
    const matches = (): boolean => {
      const location = deps().store.getRecord(sessionId)?.location
      return location?.workspaceId === workspaceId && location.executionHostId === executionHostId
    }
    // Pending creates do not yet have a record; their queued close waits for founding to finish.
    if (matches()) {
      host.context().runtimeState.acquireAborts.abort(sessionId, 'closed while starting')
    }
    return serialize(sessionId, async () => {
      if (!matches()) {
        return null
      }
      readRefusals.forget(sessionId)
      const record = deps().store.getRecord(sessionId)
      if (!record) {
        return null
      }
      const fence = record.lease.runtimeFence
      const session = sessions.get(sessionId)
      const child = session?.child
      const owned = deps().adapter.hasOwnedAcquisition?.(sessionId) === true
      const stopped = await holdStopClose(
        sessionId,
        () =>
          stopWorkspaceSleepChat({
            deps: deps(),
            sessions,
            stopAgent,
            sessionId,
            fence,
            child,
            owned,
            now: () => host.context().now()
          }),
        (error) =>
          deps().logger.warn('closing a stopped workspace chat handle failed', {
            scope: 'workspace-chat-close',
            sessionId,
            error
          })
      )
      // Lease release advances the fence; preserve the value after this close for the caller's
      // final identity check against a later restart.
      return { fence: deps().store.getRecord(sessionId)?.lease.runtimeFence ?? fence, stopped }
    })
  }

  const idleSweep = new StructuredAgentSessionIdleSweep({
    sessions,
    serialize,
    now: () => host.context().now(),
    isDisposed: () => disposed,
    deliveryActive: host.deliveryActive,
    childWorkOpen: host.childWorkOpen,
    store: {
      getRecord: (sessionId) => deps().store.getRecord(sessionId),
      replacedRuntime: (sessionId) => deps().store.replacedRuntime(sessionId)
    },
    hasOpenDispatch,
    providerHoldsDispatch,
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
    closeForWorkspaceSleep,
    idleSweep,
    stopAgent,
    /** A host stop of the child the expired attempt published, if it is still that one and still
     *  starting: its end fails what is queued, as the idle sweep's stop of a start does. */
    expireStartup: ({ sessionId, child }: StructuredAgentSessionExpiredStartup): void =>
      stopStartingChild(sessionId, child),
    /** A start that cannot finish ends as one past its limit does, outside the caller's step. */
    stopStartingChild,
    failStartingChild: (
      sessionId: string,
      failed: StructuredAgentSessionProviderChildIdentity,
      error: unknown
    ): Promise<void> =>
      serialize(sessionId, async () => {
        const session = sessions.get(sessionId)
        const child = session?.child
        if (!session || !child || child.close || !sameProviderChild(child, failed)) {
          return
        }
        const failure = providerStartupFailureFact(error)
        try {
          await recordStructuredAgentSessionStartFailure(
            { journal: session.journal, fence: child.fence },
            {
              startKey: child.generation,
              ...structuredAgentSessionStartFailure(
                { failure },
                structuredAgentSessionFailureWordsContext(deps().store.getRecord(sessionId))
              )
            }
          ).catch((writeError: unknown) =>
            deps().logger.warn('recording a failed provider open failed', {
              scope: 'provider-open-failure',
              sessionId,
              error: writeError
            })
          )
          await stopAgent(sessionId, {
            cause: 'host-stop',
            reason: error instanceof Error ? error.message : String(error),
            failure
          })
        } finally {
          host.context().runtimeState.startupAttempts.childEnded(sessionId, child)
        }
      }),
    /** Runs `task` in the chat's lane only when execution is idle. */
    runWhileExecutionIdle: <T>(sessionId: string, task: () => Promise<T>): Promise<T | null> =>
      serialize(sessionId, async () =>
        disposed ||
        sessions.get(sessionId)?.child ||
        host.deliveryActive(sessionId) ||
        providerHoldsDispatch(sessionId) ||
        hasOpenDispatch(sessionId)
          ? null
          : await task()
      ),
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
        await holdStopClose(sessionId, () => stopAgent(sessionId, { cause }))
      })
    }
  }
}
