import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import { retryableStructuredAgentSessionStart } from './structured-agent-session-start-retry'
// Open conversations at rest; never start agents for reads. Acquire serialization once because the queue is nonreentrant.

import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import { createJournalOpenReadRefusals } from '../agent-session-journal/journal-open-failure'
import { releaseLeaseOfEndedStructuredAgentSessionChild } from './structured-agent-session-child-close'
import {
  holdClosedStructuredAgentSessionSends,
  closeStructuredAgentSessionConversationUnderSerialize,
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionCloseCause,
  type StructuredAgentSessionStopEnding
} from './structured-agent-session-host-lifetime'
import type * as hostTypes from './structured-agent-session-host-types'
import { StructuredAgentSessionIdleSweep } from './structured-agent-session-idle-sweep'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { deferredStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { sameProviderChild } from './structured-agent-session-provider-child'
import type { ExecutionHostId } from '../../../shared/execution-host'
import * as sleep from './structured-agent-session-workspace-sleep-stop'
import type { StructuredAgentSessionExpiredStartup } from './structured-agent-session-startup-attempt'
import {
  providerStartupFailureFact,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import * as switchAdmission from './structured-agent-session-switch-admission'

export type StructuredAgentSessionConversationLifetime = ReturnType<
  typeof createStructuredAgentSessionConversationLifetime
>

export function createStructuredAgentSessionConversationLifetime(
  host: StructuredAgentSessionConversationLifetimeHost
) {
  let disposed = false
  const { sessions, serialize } = host
  const deps = () => host.context().deps
  const readRefusals = createJournalOpenReadRefusals(
    deferredStructuredAgentSessionLogger(() => deps().logger)
  )
  const stopAgent = (sessionId: string, ending: StructuredAgentSessionStopEnding) =>
    stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, ending)

  const closeConversation = async (sessionId: string, atRest = false): Promise<boolean> => {
    // Retain first-hand exit proof until durable lease release succeeds.
    if (await releaseLeaseOfEndedStructuredAgentSessionChild(host.context(), sessionId)) {
      return false
    }
    return closeStructuredAgentSessionConversationUnderSerialize(
      {
        sessions,
        closeStatus: (id) => {
          const tabs = deps().store.getVisibleSessionTabIndex()
          // Legacy stores cannot enumerate tabs; retain the row until restart.
          host.closeStatus(id, { listed: !tabs.present || tabs.sessionIds.includes(id) })
        }
      },
      sessionId,
      atRest
    )
  }

  const holdStopClose = async <T>(
    sessionId: string,
    stop: () => Promise<T>,
    onCloseError?: (error: unknown) => void
  ): Promise<T> => {
    const session = sessions.get(sessionId)
    if (session) {
      // Settle and pause before Stop so closed work cannot deliver automatically even if the handle stays open.
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

  const closeForWorkspaceSleep = async (
    sessionId: string,
    workspaceId: string,
    executionHostId: ExecutionHostId
  ): Promise<sleep.WorkspaceSleepCloseResult | null> => {
    const matches = (): boolean => {
      const location = deps().store.getRecord(sessionId)?.location
      return location?.workspaceId === workspaceId && location.executionHostId === executionHostId
    }
    const starts = sleep.workspaceSleepStartAborts(() => host.context().runtimeState, sessionId)
    // Pending creates do not yet have a record; their queued close waits for founding to finish.
    if (matches()) {
      starts.abort()
    }
    const closed = serialize(sessionId, async () => {
      if (!matches()) {
        return null
      }
      readRefusals.forget(sessionId)
      starts.abort()
      const record = deps().store.getRecord(sessionId)
      if (!record) {
        return null
      }
      const fence = record.lease.runtimeFence
      const admittedSends = deps().store.admittedSendCount(sessionId)
      const session = sessions.get(sessionId)
      const child = session?.child
      const owned = deps().adapter.hasOwnedAcquisition?.(sessionId) === true
      const stopped = await holdStopClose(
        sessionId,
        () =>
          sleep.stopWorkspaceSleepChat({
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
      // Return the post-release fence for checks against a later restart.
      return {
        fence: deps().store.getRecord(sessionId)?.lease.runtimeFence ?? fence,
        stopped,
        admittedSends
      }
    })
    return starts.settle({ deps: deps(), sessions, sessionId }, await closed)
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
    hasOpenDispatch: (sessionId) => {
      const record = deps().store.getRecord(sessionId)
      return record !== null && deps().hasOpenDispatch?.(record) === true
    },
    providerHoldsDispatch: (sessionId) => deps().adapter.holdsDispatch?.(sessionId) === true,
    // The host puts an idle agent to rest: a turn it cuts short is news, not the user's Stop.
    stopAgent: (sessionId) => stopAgent(sessionId, { cause: 'evict', resting: true }),
    // Word handed-over and queued startup failures from the same hostStopped fact.
    stopStartingAgent: (sessionId) => stopAgent(sessionId, { cause: 'host-stop' }),
    closeConversation: (sessionId) => closeConversation(sessionId, true),
    logger: deps().logger,
    ...deps().idleSweep
  })

  const stopStartingChild = (
    sessionId: string,
    expired: hostTypes.StructuredAgentSessionProviderChildIdentity | null
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
    /** Expire only the matching still-starting child; its end fails queued work. */
    expireStartup: ({ sessionId, child }: StructuredAgentSessionExpiredStartup): void =>
      stopStartingChild(sessionId, child),
    stopStartingChild,
    failStartingChild: (
      sessionId: string,
      failed: hostTypes.StructuredAgentSessionProviderChildIdentity,
      error: unknown,
      openMs: number
    ): Promise<void> =>
      serialize(sessionId, async () => {
        const session = sessions.get(sessionId)
        const child = session?.child
        if (!session || !child || child.close || !sameProviderChild(child, failed)) {
          return
        }
        const failure = providerStartupFailureFact(error)
        // Persisted facts cannot retain the original error; log it here.
        deps().logger.warn('a provider could not finish starting', {
          scope: 'provider-open-failed',
          sessionId,
          failure: failure.kind,
          ...failure.requestTimeout,
          openMs,
          error
        })
        const { runtimeState: runtime } = host.context()
        const owned = runtime.startFlights.ownsChild(sessionId, child)
        if (owned) {
          const retry = retryableStructuredAgentSessionStart(error)
          runtime.startupAttempts.childFailed(sessionId, child, failure, retry)
        }
        try {
          if (!owned) {
            const record = deps().store.getRecord(sessionId)
            const wording = structuredAgentSessionFailureWordsContext(record)
            await recordStructuredAgentSessionStartFailure(
              { journal: session.journal, fence: child.fence },
              {
                startKey: child.generation,
                ...structuredAgentSessionStartFailure({ failure }, wording)
              },
              oldestQueuedSubmission(session)?.clientMessageId ?? null
            ).catch((writeError: unknown) =>
              deps().logger.warn('recording a failed provider open failed', {
                scope: 'provider-open-failure',
                sessionId,
                error: writeError
              })
            )
          }
          const reason = error instanceof Error ? error.message : String(error)
          await stopAgent(sessionId, { cause: 'host-stop', reason, failure })
        } finally {
          runtime.startupAttempts.childEnded(sessionId, child)
        }
      }),
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
    conversation: async (
      sessionId: string
    ): Promise<hostTypes.StructuredAgentSessionHostSession> => {
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
        // Recheck at execution: queued reads may run after quit.
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
    /** Close resources while retaining durable chat/history and personal unsent text for the next turn. */
    close: (sessionId: string, cause: StructuredAgentSessionCloseCause): Promise<void> => {
      // Abort outside serialization so hung startup cannot block close.
      host.context().runtimeState.acquireAborts.abort(sessionId, 'closed while starting')
      return serialize(sessionId, async () => {
        readRefusals.forget(sessionId)
        host.context().runtimeState.acquireAborts.abort(sessionId, 'closed while starting')
        await holdStopClose(sessionId, () => stopAgent(sessionId, { cause }))
      })
    },
    /** Idle admission and proven-exit stop share the session queue. */
    switchToTerminal: (id: string): Promise<void> =>
      serialize(id, () =>
        switchAdmission.stopIdleStructuredAgentSessionForSwitch({
          session: sessions.get(id),
          delivering: host.deliveryActive(id),
          idleSweep,
          stop: () => holdStopClose(id, () => stopAgent(id, { cause: 'user-close' })),
          deps: deps(),
          sessionId: id
        })
      )
  }
}
