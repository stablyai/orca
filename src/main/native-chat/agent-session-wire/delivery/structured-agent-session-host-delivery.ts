import { selectableStructuredSubmission } from './structured-agent-session-input-selection'
// Open conversations with queued sends always need delivery; opening also wakes leftover recovery.

import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import { hostStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-host-current-work'
import { holdClosedStructuredAgentSessionSends } from '../termination/structured-agent-session-host-lifetime'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import {
  openStructuredAgentSessionConversation,
  observeOpenStructuredAgentSessionDeath,
  type OpenedStructuredAgentSessionConversation,
  type StructuredAgentSessionConversationOpenOptions
} from '../host/structured-agent-session-conversation-open'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import { StructuredAgentSessionDeliveryLoop } from './structured-agent-session-delivery-loop'

import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
import { structuredAgentSessionCommandRunning } from '../operations/structured-agent-session-command-turn'
import type { StructuredAgentSessionStartClaim } from '../startup/structured-agent-session-agent-start'
import type { StructuredAgentSessionStartReadiness } from '../startup/structured-agent-session-start-readiness'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from '../host/structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'
import { structuredAgentSessionFailureWordsContext } from '../operations/structured-agent-session-send-preparation'
import { settleInterruptedStructuredAgentSessionCommands } from '../rewind/structured-rewind-recovery'
import {
  retireOutgrownStructuredAgentSessionChild,
  structuredAgentSessionChildOwesWork
} from '../recovery/structured-agent-session-outgrown-child'
import {
  structuredAgentSessionLaunchPermission,
  structuredAgentSessionInputCompilerPermission,
  structuredAgentSessionImmediatePermission
} from '../options/structured-agent-session-launch-permission'
import { acceptedNoLaterThan } from '../startup/structured-agent-session-start-failure-row'
import type { StructuredAgentSessionAcquireAborts } from '../startup/structured-agent-session-acquire-aborts'
import { settleStructuredAgentSessionLeftovers } from '../termination/structured-agent-session-leftover-settlement'
import { createStructuredAgentSessionRanRecorder } from '../options/structured-agent-session-ran-options'

export type StructuredAgentSessionConversationDelivery = {
  loop: StructuredAgentSessionDeliveryLoop
  open: (
    sessionId: string,
    options?: StructuredAgentSessionConversationOpenOptions
  ) => Promise<StructuredAgentSessionHostSession | null>
  /** Queue commit wakes under serialization so they cannot race a loop’s stopping decision. */
  afterCommit: (sessionId: string, journal: AgentSessionJournal) => void
  /** Settle edges affect status/steer holds without rows or renewed idle activity. */
  afterSettleEdge: (sessionId: string, journal: AgentSessionJournal) => void
  dispose: () => void
  adoptOpened: (
    sessionId: string,
    opened: OpenedStructuredAgentSessionConversation
  ) => Promise<void>
}

export function createStructuredAgentSessionConversationDelivery(input: {
  deps: StructuredAgentSessionHostDeps
  acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  trackStart: <T>(start: Promise<T>) => Promise<T>
  startProviderChild: (sessionId: string, startedFor: string) => StructuredAgentSessionStartClaim
  deliveryOrder: StructuredAgentSessionDeliveryOrder
  startFlights?: StructuredAgentSessionDeliveryLoopDeps['startFlights']
  readiness: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => StructuredAgentSessionStartReadiness | null
  /** Stops a child the chat outgrew, so the start after it reads a new login, account or permission
   *  mode. */
  stopOutgrownAgent: (sessionId: string) => Promise<void>
  stopPermissionTransitionChild: (sessionId: string) => Promise<void>
  clientDelivery: Pick<
    StructuredAgentSessionClientDelivery,
    | 'publishRestored'
    | 'readChildWork'
    | 'childWorkOpen'
    | 'readStopping'
    | 'publishStatus'
    | 'publishStatusAndSettlement'
    | 'publishGenerationEnded'
  >
}): StructuredAgentSessionConversationDelivery {
  const { deps, sessions } = input
  const captureTitleSourceUnavailable = (sessionId: string, journal: AgentSessionJournal) =>
    deps.conversationNaming?.captureTitleSourceUnavailable?.(sessionId, journal)
  const retainedWork = (sessionId: string, continuingId?: string) => ({
    currentWork: () =>
      hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId),
    childWork: () => input.clientDelivery.readChildWork(sessionId),
    childWorkOpen: () => input.clientDelivery.childWorkOpen(sessionId),
    hasOpenDispatch: () => {
      const record = deps.store.getConversation(sessionId)
      return record !== null && deps.hasOpenDispatch?.(record) === true
    },
    providerHoldsDispatch: () =>
      deps.adapter.holdsDispatch?.(sessionId) === true ||
      [...(sessions.get(sessionId)?.child?.heldSends?.() ?? [])].some((id) => id !== continuingId)
  })
  const loop = new StructuredAgentSessionDeliveryLoop({
    captureTitleSourceUnavailable,
    sessions,
    adapter: deps.adapter,
    agents: deps.agents,
    serialize: input.serialize,
    trackStart: input.trackStart,
    startProviderChild: input.startProviderChild,
    stopPermissionTransitionChild: input.stopPermissionTransitionChild,
    retireOutgrownChild: async (sessionId, continuingId, next) => {
      // Defer retirement while personal Stop holds handover; its next step decides.
      const session = input.clientDelivery.readStopping(sessionId)
        ? undefined
        : sessions.get(sessionId)
      await retireOutgrownStructuredAgentSessionChild(sessionId, session, {
        next,
        requiresModelTransitionRestart: (submission) =>
          session?.child?.phase === 'ready' &&
          deps.adapter.requiresModelTransitionRestart?.({
            sessionId,
            fence: session.child.fence,
            executionOptions: submission.options
          }) === true,
        work: retainedWork(sessionId, continuingId),
        launchPermission: async () => {
          const record = deps.store.getRecord(sessionId)
          return (
            structuredAgentSessionInputCompilerPermission(session?.journal, continuingId) ??
            (record ? structuredAgentSessionLaunchPermission(deps, record) : null)
          )
        },
        permissionRequiresAcquisition: (mode) =>
          structuredAgentSessionInputCompilerPermission(session?.journal, continuingId)
            ? true
            : (deps.adapter.permissionModeRequiresAcquisition?.(sessionId, mode) ??
              mode !== session?.child?.permissionMode),
        stopAgent: (sessionId) => {
          deps.store.requireWritableRecord(sessionId)
          return input.stopOutgrownAgent(sessionId)
        },
        launchAccountHome: async () => {
          const record = deps.store.getRecord(sessionId)
          return record ? ((await deps.launchAccountHome?.(record, 'identity')) ?? null) : null
        },
        logger: deps.logger
      })
    },
    immediatePermission: (sessionId) => {
      const record = deps.store.getRecord(sessionId)
      return record ? structuredAgentSessionImmediatePermission(deps, record) : null
    },
    retainedWork: (sessionId, id) => {
      const session = sessions.get(sessionId)
      return (
        !!session &&
        structuredAgentSessionChildOwesWork(session.journal, retainedWork(sessionId, id))
      )
    },
    readiness: input.readiness,
    startFlights: input.startFlights,
    deliveryOrder: input.deliveryOrder,
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(deps.store, sessionId),
    closeWhatTheUserClosed: async (sessionId) => {
      const session = sessions.get(sessionId)
      const ended = session?.lastEndedChild
      return !session ||
        session.child ||
        (ended?.cause !== 'user-close' && ended?.cause !== 'workspace-sleep')
        ? true
        : holdClosedStructuredAgentSessionSends(deps, sessionId, session.journal, {
            mark: 'settled',
            which: acceptedNoLaterThan(session.journal, ended.endedAt)
          })
    },
    failureTextContext: (sessionId) =>
      structuredAgentSessionFailureWordsContext(
        deps.store.getConversation(sessionId),
        sessions.get(sessionId)?.journal
      ),
    logger: deps.logger,
    record: (sessionId) => deps.store.getRecord(sessionId),
    holdClosedInput: async (sessionId, id, fence, cause) => {
      const session = sessions.get(sessionId)
      if (
        session &&
        !(await holdClosedStructuredAgentSessionSends(
          deps,
          sessionId,
          session.journal,
          { mark: 'settled', unrun: (s) => s.clientMessageId === id && s.fence === fence },
          cause
        ))
      ) {
        throw new Error('settling an unwritten closed input failed')
      }
    },
    settleLeftovers: async (sessionId, owner) => {
      const session = sessions.get(sessionId)
      if (session) {
        const result = await settleStructuredAgentSessionLeftovers({
          store: deps.store,
          sessionId,
          journal: session.journal,
          ended: session.lastEndedChild,
          finalizingOwner: owner
        })
        if (!result.ok) {
          throw result.error
        }
      }
    },
    currentWork: (sessionId) =>
      hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId),
    readChildWork: input.clientDelivery.readChildWork,
    workChanged: (sessionId) => input.clientDelivery.publishGenerationEnded(sessionId),
    childWorkOpen: input.clientDelivery.childWorkOpen,
    stopping: input.clientDelivery.readStopping,
    now: () => deps.now?.() ?? Date.now(),
    acquireAborts: input.acquireAborts,
    recordRanOptions: (sessionId, fence) =>
      createStructuredAgentSessionRanRecorder(
        { deps, sessions, now: () => deps.now?.() ?? Date.now() },
        sessionId,
        fence
      )
  })
  const adoptOpened = async (
    sessionId: string,
    { session }: OpenedStructuredAgentSessionConversation
  ): Promise<void> => {
    sessions.set(sessionId, session)
    input.clientDelivery.publishRestored(sessionId)
    await settleInterruptedStructuredAgentSessionCommands(deps, sessionId, session)
    input.clientDelivery.publishRestored(sessionId)
    if (session.journal.inputOrder.recoverableSubmissions().some(isQueuedAgentJournalSubmission)) {
      loop.wake(sessionId)
    }
  }
  const wakesQueued = new Set<string>()
  const afterCommit = (sessionId: string, journal: AgentSessionJournal): void => {
    input.deliveryOrder.reconcile(sessionId, journal)
    if (wakesQueued.has(sessionId)) {
      return
    }
    const sourceUnavailable = captureTitleSourceUnavailable(sessionId, journal)
    const work = hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId)
    if (
      !work ||
      structuredAgentSessionCommandRunning(work) ||
      !selectableStructuredSubmission(journal, work)
    ) {
      if (!loop.isRunning(sessionId)) {
        sourceUnavailable?.()
      }
      return
    }
    wakesQueued.add(sessionId)
    void input
      .serialize(sessionId, async () => {
        wakesQueued.delete(sessionId)
        loop.wake(sessionId)
      })
      .catch((error: unknown) => {
        wakesQueued.delete(sessionId)
        sourceUnavailable?.()
        deps.logger.warn('waking the delivery loop after a commit failed', {
          scope: 'delivery-wake',
          sessionId,
          error
        })
      })
  }
  const stopResettling = observeOpenStructuredAgentSessionDeath({
    deps,
    sessions,
    trackStart: input.trackStart,
    serialize: input.serialize
  })
  return {
    loop,
    afterCommit,
    afterSettleEdge: (sessionId, journal) => {
      input.clientDelivery.publishStatusAndSettlement(sessionId)
      afterCommit(sessionId, journal)
    },
    adoptOpened,
    dispose: () => {
      loop.dispose()
      stopResettling()
    },
    open: (sessionId, options) =>
      openStructuredAgentSessionConversation({ deps, sessions, adoptOpened }, sessionId, options)
  }
}
