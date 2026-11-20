import { selectableStructuredSubmission } from './structured-agent-session-input-selection'
// Open conversations with queued sends always need delivery; opening also wakes leftover recovery.

import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import { hostStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-host-current-work'
import { readHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { holdClosedStructuredAgentSessionSends } from '../termination/structured-agent-session-host-lifetime'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import {
  openStructuredAgentSessionConversation,
  resettleOpenStructuredAgentSessionConversation,
  type OpenedStructuredAgentSessionConversation,
  type StructuredAgentSessionConversationOpenOptions
} from '../host/structured-agent-session-conversation-open'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import { StructuredAgentSessionDeliveryLoop } from './structured-agent-session-delivery-loop'

import {
  launchToolsRefreshDue,
  type StructuredAgentSessionDeliveryLoopDeps
} from './structured-agent-session-delivery-loop-deps'
import { structuredAgentSessionCommandRunning } from '../operations/structured-agent-session-command-turn'
import type { StructuredAgentSessionStartClaim } from '../startup/structured-agent-session-agent-start'
import type { StructuredAgentSessionStartReadiness } from '../startup/structured-agent-session-start-readiness'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from '../host/structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'
import { readStructuredAgentSessionFailureWordsContext } from '../operations/structured-agent-session-send-preparation'
import { settleInterruptedStructuredAgentSessionCommands } from '../rewind/structured-rewind-recovery'
import { structuredAgentSessionChildOwesWork } from '../recovery/structured-agent-session-outgrown-child'
import { structuredAgentSessionImmediatePermission } from '../options/structured-agent-session-launch-permission'
import {
  createStructuredAgentSessionOutgrownRetirement,
  retireStructuredAgentSessionChildOnOtherAccount
} from './structured-agent-session-outgrown-retirement'
import { closeWhatTheUserClosed } from '../structured-agent-session-user-closed-sends'
import type { StructuredAgentSessionAcquireAborts } from '../startup/structured-agent-session-acquire-aborts'
import type { StructuredAgentSessionStopEnding } from '../termination/structured-agent-session-host-stop-event'
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
  /** After an account switch; see `retireStructuredAgentSessionChildOnOtherAccount`. */
  offAccount: (sessionId: string, committed: () => boolean) => Promise<void>
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
  startProviderChild: (
    sessionId: string,
    startedFor: string
  ) => Promise<StructuredAgentSessionStartClaim>
  deliveryOrder: StructuredAgentSessionDeliveryOrder
  startFlights?: StructuredAgentSessionDeliveryLoopDeps['startFlights']
  readiness: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => StructuredAgentSessionStartReadiness | null
  /** Stops a chat's child as its lifetime does, for one the chat outgrew (a new login, account or
   *  permission mode) or one a permission change replaces. */
  stopAgent: (sessionId: string, ending: StructuredAgentSessionStopEnding) => Promise<void>
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
  const { launchTools } = deps
  const workHost = { store: deps.store, sessions }
  const retainedWork = (sessionId: string, continuingId?: string) => ({
    currentWork: () =>
      readHostStructuredAgentSessionWork(workHost, sessionId, { kind: 'child-work' }),
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
  const owesWork = async (sessionId: string, id: string): Promise<boolean> =>
    sessions.has(sessionId) &&
    (await structuredAgentSessionChildOwesWork(retainedWork(sessionId, id)))
  const retireOutgrownChild = createStructuredAgentSessionOutgrownRetirement({
    deps,
    sessions,
    retainedWork,
    readStopping: input.clientDelivery.readStopping,
    // Retire at rest; the next start refreshes login and permission mode.
    stopOutgrownAgent: (sessionId, onlyIf) =>
      input.stopAgent(sessionId, { cause: 'evict', resting: true, ...(onlyIf ? { onlyIf } : {}) })
  })
  const loop = new StructuredAgentSessionDeliveryLoop({
    activityChanged: (id) => sessions.get(id)?.workChanged?.(),
    sessions,
    adapter: deps.adapter,
    agents: deps.agents,
    serialize: input.serialize,
    trackStart: input.trackStart,
    startProviderChild: input.startProviderChild,
    stopPermissionTransitionChild: (sessionId) => input.stopAgent(sessionId, { cause: 'evict' }),
    retireOutgrownChild,
    immediatePermission: (sessionId) => {
      const record = deps.store.getRecord(sessionId)
      return record ? structuredAgentSessionImmediatePermission(deps, record) : null
    },
    retainedWork: owesWork,
    ...(launchTools ? { launchToolsRefreshDue: launchToolsRefreshDue(launchTools, owesWork) } : {}),
    readiness: input.readiness,
    startFlights: input.startFlights,
    deliveryOrder: input.deliveryOrder,
    conversationFence: (id) => structuredAgentSessionConversationFence(deps.store, id),
    closeWhatTheUserClosed: (sessionId) => closeWhatTheUserClosed(deps, sessions, sessionId),
    turnContext: deps.turnContext,
    failureTextContext: async (sessionId) =>
      readStructuredAgentSessionFailureWordsContext(
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
          { mark: 'settled', unrun: { only: { clientMessageId: id, fence } } },
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
    currentWork: (sessionId) => hostStructuredAgentSessionCurrentWork(workHost, sessionId),
    readWork: (sessionId) => (operation) =>
      readHostStructuredAgentSessionWork(workHost, sessionId, operation),
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
    if (
      (await session.journal.reads.input({ kind: 'recoverable-submissions' })).submissions.some(
        isQueuedAgentJournalSubmission
      )
    ) {
      loop.wake(sessionId)
    }
  }
  const wakesQueued = new Set<string>()
  const afterCommit = (sessionId: string, journal: AgentSessionJournal): void => {
    if (wakesQueued.has(sessionId)) {
      return
    }
    wakesQueued.add(sessionId)
    void input
      .serialize(sessionId, async () => {
        wakesQueued.delete(sessionId)
        await input.deliveryOrder.reconcile(sessionId, journal)
        const work = await hostStructuredAgentSessionCurrentWork(
          { store: deps.store, sessions },
          sessionId
        )
        if (
          work &&
          !structuredAgentSessionCommandRunning(work) &&
          (await selectableStructuredSubmission(journal, work))
        ) {
          void loop.wake(sessionId)
        }
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
      input.clientDelivery.publishStatusAndSettlement(sessionId)
      afterCommit(sessionId, journal)
    },
    adoptOpened,
    offAccount: (sessionId, committed) =>
      retireStructuredAgentSessionChildOnOtherAccount(sessionId, {
        committed,
        sessions,
        serialize: input.serialize,
        delivering: (id) => loop.isRunning(id),
        retire: retireOutgrownChild
      }),
    dispose: () => {
      loop.dispose()
      stopResettling()
    },
    open: (sessionId, options) =>
      openStructuredAgentSessionConversation({ deps, sessions, adoptOpened }, sessionId, options)
  }
}
