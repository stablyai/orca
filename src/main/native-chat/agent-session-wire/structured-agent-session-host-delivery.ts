// Open conversations with queued sends always need delivery; opening also wakes leftover recovery.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { holdClosedStructuredAgentSessionSends } from './structured-agent-session-host-lifetime'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  openStructuredAgentSessionConversation,
  resettleOpenStructuredAgentSessionConversation,
  type OpenedStructuredAgentSessionConversation,
  type StructuredAgentSessionConversationOpenOptions
} from './structured-agent-session-conversation-open'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import {
  StructuredAgentSessionDeliveryLoop,
  type StructuredAgentSessionDeliveryLoopDeps
} from './structured-agent-session-delivery-loop'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import { recoverStructuredRewind } from './structured-rewind-recovery'
import {
  retireOutgrownStructuredAgentSessionChild,
  structuredAgentSessionChildOwesWork
} from './structured-agent-session-outgrown-child'
import {
  structuredAgentSessionLaunchPermission,
  structuredAgentSessionInputCompilerPermission,
  structuredAgentSessionImmediatePermission
} from './structured-agent-session-launch-permission'
import { acceptedNoLaterThan } from './structured-agent-session-start-failure-row'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { settleStructuredAgentSessionLeftovers } from './structured-agent-session-leftover-settlement'
import { createStructuredAgentSessionRanRecorder } from './structured-agent-session-ran-options'

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
  /** Next start must reflect changed login/permission mode. */
  stopOutgrownAgent: (sessionId: string) => Promise<void>
  clientDelivery: Pick<
    StructuredAgentSessionClientDelivery,
    | 'publishRestored'
    | 'readChildWork'
    | 'childWorkOpen'
    | 'readStopping'
    | 'publishStatus'
    | 'publishGenerationEnded'
  >
}): StructuredAgentSessionConversationDelivery {
  const { deps, sessions } = input
  const retainedWork = (sessionId: string, continuingId?: string) => ({
    currentWork: () =>
      hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId),
    childWork: () => input.clientDelivery.readChildWork(sessionId),
    childWorkOpen: () => input.clientDelivery.childWorkOpen(sessionId),
    hasOpenDispatch: () => {
      const record = deps.store.getRecord(sessionId)
      return record !== null && deps.hasOpenDispatch?.(record) === true
    },
    providerHoldsDispatch: () =>
      deps.adapter.holdsDispatch?.(sessionId) === true ||
      [...(sessions.get(sessionId)?.child?.heldSends?.() ?? [])].some((id) => id !== continuingId)
  })
  const loop = new StructuredAgentSessionDeliveryLoop({
    sessions,
    adapter: deps.adapter,
    agents: deps.agents,
    serialize: input.serialize,
    trackStart: input.trackStart,
    startProviderChild: input.startProviderChild,
    retireOutgrownChild: async (sessionId, continuingId) => {
      // Defer retirement while personal Stop holds handover; its next step decides.
      const session = input.clientDelivery.readStopping(sessionId)
        ? undefined
        : sessions.get(sessionId)
      await retireOutgrownStructuredAgentSessionChild(sessionId, session, {
        work: retainedWork(sessionId, continuingId),
        launchPermission: async () => {
          const record = deps.store.getRecord(sessionId)
          return (
            structuredAgentSessionInputCompilerPermission(session?.journal, continuingId) ??
            (record ? structuredAgentSessionLaunchPermission(deps, record) : null)
          )
        },
        permissionRequiresAcquisition: (mode) =>
          continuingId
            ? true
            : (deps.adapter.permissionModeRequiresAcquisition?.(sessionId, mode) ??
              mode !== session?.child?.permissionMode),
        stopAgent: input.stopOutgrownAgent,
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
      return !session || session.child || ended?.cause !== 'user-close'
        ? true
        : holdClosedStructuredAgentSessionSends(deps, sessionId, session.journal, {
            mark: 'settled',
            which: acceptedNoLaterThan(session.journal, ended.endedAt)
          })
    },
    failureTextContext: (sessionId) =>
      structuredAgentSessionFailureWordsContext(
        deps.store.getRecord(sessionId),
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
    opened: OpenedStructuredAgentSessionConversation
  ): Promise<void> => {
    const { session } = opened
    sessions.set(sessionId, session)
    input.clientDelivery.publishRestored(sessionId)
    await settleInterruptedCommands(deps, sessionId, session)
    if (session.journal.submissions().some(isQueuedAgentJournalSubmission)) {
      loop.wake(sessionId)
    }
  }
  const wakesQueued = new Set<string>()
  const afterCommit = (sessionId: string, journal: AgentSessionJournal): void => {
    input.deliveryOrder.reconcile(sessionId, journal.submissions())
    const work = hostStructuredAgentSessionCurrentWork({ store: deps.store, sessions }, sessionId)
    if (
      wakesQueued.has(sessionId) ||
      !work ||
      structuredAgentSessionCommandRunning(work) ||
      !journal.submissions().some(isQueuedAgentJournalSubmission)
    ) {
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
        deps.logger.warn('waking the delivery loop after a commit failed', {
          scope: 'delivery-wake',
          sessionId,
          error
        })
      })
  }
  // Queue death-proof revisions without awaiting: the writer may already hold session serialization.
  const stopResettling = deps.store.onDeathEvidence((sessionId) => {
    const session = sessions.get(sessionId)
    // User-close retires its handle; the next open can derive proof.
    if (session && session.child?.close?.cause !== 'user-close') {
      void input
        .trackStart(
          input.serialize(sessionId, () =>
            resettleOpenStructuredAgentSessionConversation(deps, sessionId, sessions.get(sessionId))
          )
        )
        .catch((error: unknown) =>
          deps.logger.warn('resettling an open chat after its owner died failed', {
            scope: 'death-evidence-resettle',
            sessionId,
            error
          })
        )
    }
  })
  return {
    loop,
    afterCommit,
    afterSettleEdge: (sessionId, journal) => {
      input.clientDelivery.publishStatus(sessionId)
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

/** Settle prepared rewinds orphaned across processes; provider-only proof waits for the next proven start. */
async function settleInterruptedCommands(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  session: StructuredAgentSessionHostSession
): Promise<void> {
  const fence = structuredAgentSessionConversationFence(deps.store, sessionId)
  try {
    await recoverStructuredRewind(deps, sessionId, session.journal, fence)
  } catch (error) {
    deps.logger.warn('settling an interrupted rewind on open failed', {
      scope: 'rewind-recovery',
      sessionId,
      error
    })
  }
}
