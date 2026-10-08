import type { AgentSessionRewindParams } from '../../../shared/agent-session-rewind'
import { rewindStructuredAgentSession } from './structured-agent-session-rewind'
import { StructuredConversationCommandController } from './structured-conversation-command-controller'
// Structured agent-session host: where the lease, journal, and provider adapter meet.
// Mutations share one durable admission path and serialize per session. A conversation is reached
// only through `conversation`, which opens it at rest; an agent is started only by work that needs
// it, and the idle sweep is the one thing that puts it to rest.

import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type * as SessionWire from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import type { AgentSessionSubscribeInput } from './structured-agent-session-subscribers'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import * as reveal from './structured-agent-session-reveal'
import { structuredAgentSessionOwnerStatus } from './structured-agent-session-owner-status'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import * as agentStart from './structured-agent-session-agent-start'
import {
  createStructuredAgentSessionConversationLifetime,
  type StructuredAgentSessionConversationLifetime
} from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import * as sessionTabs from './structured-agent-session-host-tabs'
import {
  structuredAgentSessionMutationDelegates,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'
import { settleStructuredAgentSessionLateDispatch } from './structured-agent-session-late-dispatch'
import { releaseStructuredAgentSessionUnansweredDispatches } from './structured-agent-session-unanswered-dispatch-release'
import { flushStructuredAgentSessionHost } from './structured-agent-session-host-teardown'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'
import { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import { StructuredAgentSessionBackgroundTaskChannel } from './structured-agent-session-background-task-channel'
import { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import {
  createStructuredAgentSessionRestartResume,
  type StructuredAgentSessionRestartResume
} from './structured-agent-session-restart-resume-host'
import { structuredAgentSessionRestartResumeSurfaces } from './structured-agent-session-restart-resume-wiring'
import * as conversation from './structured-agent-session-host-delivery'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { wireStructuredAgentSessionQueuedMessages } from './structured-agent-session-queued-wiring'
import * as sessionLogger from './structured-agent-session-logger'
export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export class StructuredAgentSessionHost {
  private readonly conversationCommands = new StructuredConversationCommandController(
    () => this.mutationContext(),
    this
  )
  private readonly sessions = new StructuredAgentSessionConversations({
    deliver: (sessionId, journal) => {
      this.subscribers.publish(sessionId, journal)
      this.conversationDelivery.afterCommit(sessionId, journal)
    },
    deliverSettleEdge: (id, journal) => this.conversationDelivery.afterSettleEdge(id, journal),
    logger: sessionLogger.deferredStructuredAgentSessionLogger(() => this.deps.logger),
    onOpened: (sessionId) => this.queued.drain.schedule(sessionId),
    now: () => this.now()
  })
  private readonly queued = wireStructuredAgentSessionQueuedMessages(this.sessions, () =>
    this.mutationContext()
  )
  // Every journal publish is activity: the one renewal the idle sweep reads.
  private readonly clientDelivery = new StructuredAgentSessionClientDelivery(
    this.sessions,
    () => this.now(),
    () => this.deps,
    (sessionId) => this.queued.onJournalActivity(sessionId),
    (sessionId) => this.restartResume.onAgentStarted(sessionId),
    (sessionId) => this.backgroundTasks.publish(sessionId),
    (sessionId) => this.backgroundTasks.read(sessionId)
  )
  private readonly subscribers = this.clientDelivery.subscribers
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly reconcileLeases: ReturnType<typeof createRestartReconciler>
  private readonly restore: ReturnType<typeof reveal.createStructuredAgentSessionHostRestore>
  private readonly lifetime: StructuredAgentSessionConversationLifetime
  private readonly conversationDelivery: conversation.StructuredAgentSessionConversationDelivery
  private readonly eventRecovery: StructuredAgentSessionEventRecovery
  private readonly backgroundTasks: StructuredAgentSessionBackgroundTaskChannel
  /** Public because the RPC surface addresses it directly; see the restart-resume collaborator. */
  readonly restartResume: StructuredAgentSessionRestartResume

  constructor(readonly deps: StructuredAgentSessionHostDeps) {
    // Every collaborator reads this copy, so a logger that throws cannot fail what it reports.
    this.deps = deps = sessionLogger.withNeverThrowingLogger(deps)
    this.clientDelivery.watchAtRestCommands(deps.adapter)
    this.backgroundTasks = new StructuredAgentSessionBackgroundTaskChannel(
      deps,
      this.sessions,
      this.subscribers,
      (sessionId) => this.lifetime.conversation(sessionId),
      this.clientDelivery.readChildWork
    )
    this.runtimeState = new StructuredAgentSessionHostRuntimeState(deps, this.sessions, (id, e) =>
      this.eventRecovery.recoverAfterSinkFailure(id, e)
    )
    this.reconcileLeases = createRestartReconciler({
      store: deps.store,
      probe: (record) => this.runtimeState.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      now: () => this.now()
    })
    this.conversationDelivery = conversation.createStructuredAgentSessionConversationDelivery({
      deps,
      sessions: this.sessions,
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      // Quit drains a delivery start before it evicts, so the child it produces is stopped.
      trackStart: (start) => this.tasks.trackAttach(start),
      ensureProviderChild: (sessionId, startedFor) =>
        agentStart.ensureStructuredAgentSessionAgent(this.attachContext(), sessionId, startedFor),
      clientDelivery: this.clientDelivery
    })
    this.restore = reveal.createStructuredAgentSessionHostRestore(deps, {
      reconcileLeases: this.reconcileLeases,
      resolveRecovery: (sessionId) => this.runtimeState.resolveRecovery(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      hasSession: this.hasSession,
      // Site 10: cannot overwrite a live entry — the restorer returns early on
      // `hasSession` inside the same serialized step as this `set`.
      onReadable: this.conversationDelivery.adoptOpened,
      restoreSaved: this.clientDelivery.restoreSavedStatus,
      close: (sessionId) => this.close(sessionId, 'evict')
    })
    this.eventRecovery = new StructuredAgentSessionEventRecovery({
      deps,
      store: deps.store,
      sessions: this.sessions,
      flushLifecycle: (sessionId) => this.runtimeState.lifecycleBarrier(sessionId),
      publishFence: (sessionId, session) =>
        this.subscribers.snapshot(
          sessionId,
          session.journal,
          structuredAgentSessionConversationFence(deps.store, sessionId)
        ),
      publishStatus: this.clientDelivery.publishStatusAndSettlement,
      serialize: (sessionId, task) => this.tasks.trackAttach(this.serialize(sessionId, task)),
      now: () => this.now(),
      runtimeState: this.runtimeState,
      wakeDelivery: (sessionId) => this.conversationDelivery.loop.wake(sessionId)
    })
    this.restartResume = createStructuredAgentSessionRestartResume(deps, this.sessions, {
      ...structuredAgentSessionRestartResumeSurfaces(this, this.now),
      readChildWork: this.clientDelivery.readChildWork
    })
    this.lifetime = createStructuredAgentSessionConversationLifetime({
      context: () => this.lifetimeContext(),
      sessions: this.sessions,
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      open: (sessionId) => this.conversationDelivery.open(sessionId),
      deliveryActive: (sessionId) => this.conversationDelivery.loop.isRunning(sessionId),
      closeStatus: (sessionId, options) => this.clientDelivery.closeSession(sessionId, options),
      readChildWork: this.clientDelivery.readChildWork
    })
    this.runtimeState.startLeaseRenewal()
    this.lifetime.idleSweep.start()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)
  sessionAgent = (sessionId: string) => this.deps.store.getRecord(sessionId)?.provider ?? null

  handleAdapterEvent = (event: Parameters<StructuredAgentSessionEventRecovery['handle']>[0]) =>
    this.eventRecovery.handle(event)

  // Inferred, so the attach context's spread keeps `publishStatus` required.
  private lifetimeContext() {
    return {
      deps: this.deps,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      now: () => this.now(),
      publishStatus: this.clientDelivery.publishStatus,
      wakeDelivery: (sessionId: string) => this.conversationDelivery.loop.wake(sessionId),
      endExitedChild: this.eventRecovery.endExitedChildUnderSerialize
    } satisfies StructuredAgentSessionLifetimeContext
  }

  /** The host's half of attaching, named so it cannot grow dependencies unnoticed. */
  private attachContext(): StructuredAgentSessionAttachContext {
    return {
      ...this.lifetimeContext(),
      subscribers: this.subscribers,
      tasks: this.tasks,
      reconcileLeases: (sessionId) => this.reconcileLeases(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      openConversation: this.conversationDelivery.open
    }
  }
  /** Releases a session's resources without ending the conversation; see the lifetime's close.
   *  `user-close` makes a turn it cuts short the user's cancellation; an `evict` leaves it news. */
  close: StructuredAgentSessionConversationLifetime['close'] = (sessionId, cause) =>
    this.lifetime.close(sessionId, cause)

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    providerSupport.adapterSupportsCreate(this.deps.adapter, location, agent)

  /** Every agent this runtime registered: what `agentSession.agents` publishes. */
  agentDefinitions = () => this.deps.agents.definitions()

  /** Saved chats can outlive their registration; both vocabularies bound a client's audience. */
  knownAgentIds = (): readonly string[] => [
    ...new Set([
      ...this.deps.agents.definitions().map(({ agent }) => agent),
      ...this.deps.store.listRecords().map(({ provider }) => provider)
    ])
  ]

  private readonly tabs = sessionTabs.createStructuredAgentSessionTabSurface(
    this,
    this.sessions,
    (sessionId) => this.clientDelivery.forgetStatus(sessionId)
  )
  listSessionTabs = this.tabs.listSessionTabs
  getPersistedVisibleSessionTabIndex = this.tabs.getPersistedVisibleSessionTabIndex
  getSessionTabId = this.tabs.getSessionTabId
  showSessionTabs = this.tabs.showSessionTabs
  setSessionTabVisibility = this.tabs.setSessionTabVisibility
  notifySessionTabHidden = this.tabs.notifySessionTabHidden
  /** This runtime holds a chat record, readable or not. */
  holdsSessions = (): boolean => this.deps.store.holdsRecords()
  onSessionsHeld = (listener: () => void): (() => void) => this.deps.store.onFirstRecord(listener)

  reconcileRestartLeases = (): Promise<void> => this.restore.reconcileRestartLeases()

  /** Startup, after the lease check: see `structured-agent-session-saved-status-restore`. */
  restoreSavedStatuses = (listed: readonly string[], owedMail?: readonly string[]): Promise<void> =>
    this.restore.restoreSavedStatuses(listed, owedMail)

  /** Make one persisted session addressable again; see `structured-agent-session-reveal`. */
  revealSession = (sessionId: string): Promise<StructuredAgentSessionReveal> =>
    reveal.revealStructuredAgentSession(this.deps, sessionId, this.lifetime.conversation)

  private serialize = this.tasks.serialize.bind(this.tasks)

  attach(
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams,
    options?: Parameters<typeof attachStructuredAgentSession>[3]
  ): Promise<SessionWire.AgentSessionMutationResult<SessionWire.AgentSessionAttachResult>> {
    return attachStructuredAgentSession(this.attachContext(), caller.callerKey, params, options)
  }

  /** Test barrier: every write has landed by its call's return, so no production path needs it. */
  flushStreamedEvents = (id: string): Promise<void> => this.runtimeState.flushEventSink(id)

  // Trigger inlined rather than imported: `AgentSessionResumeTrigger` in shared is the canonical
  // type, and this file has no line budget left for the import.
  /** Quit: no exit or recovery settled after this starts a child or hands a message over, and the
   *  queue hands no card over. */
  stopDelivery = (): void =>
    [this.conversationDelivery, this.queued.drain].forEach((d) => d.dispose())

  async flushAllStreamedEvents(options?: { trigger?: 'quit' | 'update' }): Promise<void> {
    this.stopDelivery()
    await flushStructuredAgentSessionHost({
      ...this.lifetimeContext(),
      idleSweep: this.lifetime,
      tasks: this.tasks,
      restartResume: this.restartResume,
      serialize: this.serialize,
      trigger: options?.trigger ?? 'quit'
    }).finally(() => this.clientDelivery.closeAll())
  }

  private mutationContext(): StructuredAgentSessionMutationContext {
    return {
      deps: this.deps,
      sessions: this.sessions,
      publish: (sessionId, journal) => this.subscribers.publish(sessionId, journal),
      conversation: this.lifetime.conversation,
      readChildWork: this.clientDelivery.readChildWork,
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      openConversation: this.conversationDelivery.open,
      ensureAgent: (sessionId) =>
        agentStart.ensureStructuredAgentSessionAgentForOperation(this.attachContext(), sessionId),
      joinChildClose: (sessionId) =>
        agentStart.joinClosingStructuredAgentSessionChild(this.attachContext(), sessionId),
      wakeDelivery: (sessionId) => this.conversationDelivery.loop.wake(sessionId),
      stopAgent: (sessionId, ending) => this.lifetime.stopAgent(sessionId, ending),
      wakeQueuedDrain: (sessionId) => this.queued.drain.schedule(sessionId),
      acquireAborts: this.runtimeState.acquireAborts,
      now: () => this.now()
    }
  }

  send = this.conversationCommands.send

  queuedMessageSend = this.queued.queuedMessageSend
  queuedMessageDelete = this.queued.queuedMessageDelete
  queuedMessagesResume = this.queued.queuedMessagesResume

  waitForSendSettlement = this.clientDelivery.waitForSendSettlement

  private mutations = structuredAgentSessionMutationDelegates(() => this.mutationContext())
  cancel = this.mutations.cancel
  respondToPrompt = this.mutations.respondToPrompt
  setOption = this.mutations.setOption
  changeThreadGoal = this.mutations.changeThreadGoal
  readOptions = this.mutations.readOptions

  rewind = (caller: StructuredAgentSessionCaller, params: AgentSessionRewindParams) =>
    rewindStructuredAgentSession(this.mutationContext(), this.attachContext(), caller, params)

  conversationCommand = (...args: Parameters<StructuredConversationCommandController['run']>) =>
    this.conversationCommands.run(...args)
  conversationReplacements = () => this.conversationCommands.replacements()
  /** Undefined means unavailable; an empty array is an authoritative catalog. */
  readCommands = (sessionId: string) => ({ commands: this.clientDelivery.readCommands(sessionId) })

  /** From the record store, never the session map: an idle-released chat has no map entry. */
  handoffStatus = (sessionId: string): SessionWire.AgentSessionHandoffStatus =>
    structuredAgentSessionOwnerStatus(this.deps, sessionId)

  history: StructuredAgentSessionBackgroundTaskChannel['history'] = (request, scope) =>
    this.backgroundTasks.history(request, scope)

  /** The fully reduced timeline, for readers that cannot tolerate a page's ambiguity — rows are
   *  revised or tombstoned in place, so an item's ABSENCE from a bounded page proves nothing. */
  journalSnapshot = async (sessionId: string): Promise<AgentJournalSnapshot> =>
    (await this.lifetime.conversation(sessionId)).journal.snapshot()

  subscribe = (input: AgentSessionSubscribeInput) => this.backgroundTasks.subscribe(input)

  settleLateDispatch = (input: Parameters<typeof settleStructuredAgentSessionLateDispatch>[1]) =>
    settleStructuredAgentSessionLateDispatch(this.mutationContext(), input)

  releaseUnansweredDispatches = (
    input: Parameters<typeof releaseStructuredAgentSessionUnansweredDispatches>[1]
  ) => releaseStructuredAgentSessionUnansweredDispatches(this.mutationContext(), input)

  publishChildWorkEvidence = this.clientDelivery.publishChildWork
  unsubscribe = (sessionId: string, id: string): void => this.subscribers.close(sessionId, id)

  /** Every session's projected status for session lists; unlike `subscribe`, retains nothing. */
  subscribeStatus = this.clientDelivery.subscribeStatus
  publishConversationName = this.clientDelivery.publishConversationName

  /** Turns that settle, and prompts raised, from now on. Live-only: nothing missed is replayed. */
  subscribeTurnCompletions = this.clientDelivery.subscribeTurnCompletions
  readStatusSummary = this.clientDelivery.readStatusSummary

  /** Test rigs only: the collaborators the host builds itself, typed, for tests that drive them. */
  collaboratorsForTests = () => ({
    sessions: this.sessions,
    subscribers: this.subscribers,
    runtimeState: this.runtimeState,
    conversationDelivery: this.conversationDelivery,
    lifetime: this.lifetime,
    serialize: this.serialize,
    /** The open-and-settle pass startup runs for the chats a restart owes, over any ids. */
    restoreReadableSessions: this.restore.restoreReadableSessions
  })
}
