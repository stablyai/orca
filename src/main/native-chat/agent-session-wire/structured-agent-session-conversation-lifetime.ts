import {
  createStructuredAgentSessionStopStartingChild,
  cutClosingStructuredAgentSession,
  type StructuredAgentSessionConversationLifetimeHost
} from './structured-agent-session-conversation-lifetime-host'
export type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-host-types'
import { closeStructuredAgentSessionHandovers } from './structured-agent-session-handing-over'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import { createJournalOpenReadRefusals } from '../agent-session-journal/journal-open-failure'
import { releaseLeaseOfEndedStructuredAgentSessionChild } from './structured-agent-session-child-close'
import {
  beginFinalizedStructuredAgentSessionClose,
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
import type { ExecutionHostId } from '../../../shared/execution-host'
import * as sleep from './structured-agent-session-workspace-sleep-stop'
import type { StructuredAgentSessionExpiredStartup } from './structured-agent-session-startup-attempt'
import { settleStructuredAgentSessionFailedStart } from './structured-agent-session-failed-start-settlement'
import { createStructuredAgentSessionSwitchCommands } from './structured-agent-session-switch-commands'

// Open conversations at rest; never start agents for reads. Acquire serialization once because the queue is nonreentrant.

export function createStructuredAgentSessionConversationLifetime(
  host: StructuredAgentSessionConversationLifetimeHost
) {
  let disposed = false
  const { sessions, serialize } = host
  const deps = () => host.context().deps
  const switchCommands = createStructuredAgentSessionSwitchCommands(host, () => disposed)
  const readRefusals = createJournalOpenReadRefusals(
    deferredStructuredAgentSessionLogger(() => deps().logger)
  )
  const stopAgent = (sessionId: string, ending: StructuredAgentSessionStopEnding) =>
    stopStructuredAgentSessionAgentUnderSerialize(host.context(), sessionId, ending)

  const closeConversation = async (
    sessionId: string,
    atRest = false,
    ownSwitch = false
  ): Promise<boolean> => {
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
      atRest,
      ownSwitch
    )
  }

  const closeContext = { sessions, serialize, closeConversation, deps }

  const holdStopClose = async <T>(
    sessionId: string,
    stop: () => Promise<T>,
    onCloseError?: (error: unknown) => void
  ): Promise<T> => {
    const session = sessions.get(sessionId)
    const finishClose = beginFinalizedStructuredAgentSessionClose(closeContext, sessionId, session)
    if (session) {
      // Settle and pause before Stop so closed work cannot deliver automatically even if the handle stays open.
      await holdClosedStructuredAgentSessionSends(deps(), sessionId, session.journal, {
        mark: 'always'
      })
    }
    const result = await stop()
    finishClose?.()
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
      const location = deps().store.getConversation(sessionId)?.location
      return location?.workspaceId === workspaceId && location.executionHostId === executionHostId
    }
    const starts = sleep.workspaceSleepStartAborts(() => host.context().runtimeState, sessionId)
    // Pending creates have no record yet; their queued close waits for founding.
    const matched = matches()
    const revoked = matched && switchCommands.revoke(sessionId)
    if ((revoked ? matches() : matched) && deps().store.getRecord(sessionId)) {
      const journal = sessions.get(sessionId)?.journal
      if (journal) {
        closeStructuredAgentSessionHandovers(journal)
      }
      starts.abort()
    }
    const closed = serialize(sessionId, async () => {
      if (!matches()) {
        return null
      }
      readRefusals.forget(sessionId)
      const record = deps().store.getConversation(sessionId)
      if (!record) {
        return null
      }
      const fence = record.currentFence
      const admittedSends = deps().store.admittedSendCount(sessionId)
      if (deps().store.getRecord(sessionId)) {
        starts.abort()
      }
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
        fence: deps().store.getConversation(sessionId)?.currentFence ?? fence,
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
      getConversation: (sessionId) => deps().store.getConversation(sessionId),
      replacedRuntime: (sessionId) => deps().store.replacedRuntime(sessionId)
    },
    hasOpenDispatch: (sessionId) => {
      const record = deps().store.getConversation(sessionId)
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

  const stopStartingChild = createStructuredAgentSessionStopStartingChild(host)
  return {
    ...switchCommands.controls,
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
      settleStructuredAgentSessionFailedStart(host, stopAgent, sessionId, failed, error, openMs),
    dispose: (): void => {
      disposed = true
      switchCommands.dispose()
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
      const record = deps().store.getConversation(sessionId)
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
    /** `admit` decides in the session lane, after any send admitted first; false throws. A close
     *  that may yet be refused cuts no handover or start before then. */
    close: (sessionId: string, cause: StructuredAgentSessionCloseCause, admit?: () => boolean) => {
      if (!admit) {
        switchCommands.revoke(sessionId)
        cutClosingStructuredAgentSession(host, sessionId)
      }
      return serialize(sessionId, async () => {
        if (admit) {
          cutClosingStructuredAgentSession(host, sessionId, admit)
          switchCommands.revoke(sessionId)
        }
        readRefusals.forget(sessionId)
        if (deps().store.selectWritableRecord(sessionId).kind !== 'unreadable') {
          host.context().runtimeState.acquireAborts.abort(sessionId, 'closed while starting')
        }
        await holdStopClose(sessionId, () => stopAgent(sessionId, { cause }))
      })
    }
  }
}
