import type { AgentSessionRewindParams } from '../../../shared/agent-session-rewind'
import { rewindStructuredAgentSession } from './structured-agent-session-rewind'
import { StructuredConversationCommandController } from './structured-conversation-command-controller'
// Serialize durable mutations per conversation; open at rest and start a child only when work needs it.

import type { AgentSessionSubscribeInput } from './structured-agent-session-subscribers'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import * as reveal from './structured-agent-session-reveal'
import { structuredAgentSessionOwnerStatus } from './structured-agent-session-owner-status'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { structuredAgentSessionEntryDelegates } from './structured-agent-session-create'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import * as agentStart from './structured-agent-session-agent-start'
import { createStructuredAgentSessionHostMutationContext } from './structured-agent-session-host-mutation-wiring'
import * as lifetime from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { createStructuredAgentSessionTabSurface as createTabs } from './structured-agent-session-host-tabs'
import {
  structuredAgentSessionMutationDelegates,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'
import { flushStructuredAgentSessionHost } from './structured-agent-session-host-teardown'
import type * as HostTypes from './structured-agent-session-host-types'
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
import { wireStructuredAgentSessionQueuedMessages } from './structured-agent-session-queued-wiring'
import * as sessionLogger from './structured-agent-session-logger'
import { sleepStructuredAgentSessionWorkspace } from './structured-agent-session-workspace-sleep'
export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export class StructuredAgentSessionHost {
  private readonly conversationCommands = new StructuredConversationCommandController(
    () => this.mutationContext(),
    this
  )
  private readonly sessions = new StructuredAgentSessionConversations({
    observe: (id, journal, rows) => this.clientDelivery.requestFailures.observe(id, journal, rows),
    forget: (id) => this.clientDelivery.requestFailures.forget(id),
    deliver: (sessionId, journal) => {
      this.subscribers.publish(sessionId, journal)
      this.conversationDelivery.afterCommit(sessionId, journal)
    },
    deliverSettleEdge: (id, journal) => this.conversationDelivery.afterSettleEdge(id, journal),
    logger: sessionLogger.deferredStructuredAgentSessionLogger(() => this.deps.logger),
    onOpened: (sessionId) => this.queued.onOpened(sessionId),
    now: () => this.now()
  })
  private readonly queued = wireStructuredAgentSessionQueuedMessages(this.sessions, () =>
    this.mutationContext()
  )
  // Journal publication renews idle activity.
  private readonly clientDelivery = new StructuredAgentSessionClientDelivery(
    this.sessions,
    () => this.now(),
    () => this.deps,
    this.queued,
    (sessionId) => this.restartResume.onAgentStarted(sessionId),
    (sessionId) => this.backgroundTasks.publish(sessionId),
    (sessionId) => this.backgroundTasks.read(sessionId)
  )
  private readonly subscribers = this.clientDelivery.subscribers
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly reconcileLeases: ReturnType<typeof createRestartReconciler>
  private readonly restore: ReturnType<typeof reveal.createStructuredAgentSessionHostRestore>
  private readonly lifetime: lifetime.StructuredAgentSessionConversationLifetime
  private readonly conversationDelivery: conversation.StructuredAgentSessionConversationDelivery
  private readonly eventRecovery: StructuredAgentSessionEventRecovery
  private readonly backgroundTasks: StructuredAgentSessionBackgroundTaskChannel
  readonly restartResume: StructuredAgentSessionRestartResume

  constructor(readonly deps: HostTypes.StructuredAgentSessionHostDeps) {
    // Collaborators share a logger wrapper that cannot fail the operation it reports.
    this.deps = deps = sessionLogger.withNeverThrowingLogger(deps)
    this.clientDelivery.watchAtRestCommands(deps.adapter)
    this.backgroundTasks = new StructuredAgentSessionBackgroundTaskChannel(
      deps,
      this.sessions,
      this.subscribers,
      (sessionId) => this.lifetime.conversation(sessionId),
      this.clientDelivery.readChildWork,
      this.clientDelivery.childWorkIncomplete
    )
    this.runtimeState = new StructuredAgentSessionHostRuntimeState(
      deps,
      this.sessions,
      (id, e) => this.eventRecovery.recoverAfterSinkFailure(id, e),
      (expired) => this.lifetime.expireStartup(expired)
    )
    this.reconcileLeases = createRestartReconciler({
      store: deps.store,
      probe: (record) => this.runtimeState.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      now: () => this.now()
    })
    this.conversationDelivery = conversation.createStructuredAgentSessionConversationDelivery({
      deps,
      acquireAborts: this.runtimeState.acquireAborts,
      sessions: this.sessions,
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      // Quit drains tracked starts before eviction so their children are stopped.
      trackStart: (start) => this.tasks.trackAttach(start),
      startProviderChild: (sessionId, startedFor) =>
        agentStart.claimStructuredAgentSessionAgent(this.attachContext(), sessionId, startedFor),
      deliveryOrder: this.runtimeState.deliveryOrder,
      readiness: (id, child) => this.runtimeState.startupAttempts.readiness(id, child),
      // Retire at rest; the next start refreshes login and permission mode.
      stopOutgrownAgent: (id) => this.lifetime.stopAgent(id, { cause: 'evict', resting: true }),
      clientDelivery: this.clientDelivery
    })
    this.restore = reveal.createStructuredAgentSessionHostRestore(deps, {
      reconcileLeases: this.reconcileLeases,
      reconcileRestartLeases: () => this.reconcileLeases(),
      resolveRecovery: (sessionId) => this.runtimeState.resolveRecovery(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      hasSession: this.hasSession,
      // Restore checks hasSession before adoption, preserving live entries.
      onReadable: this.conversationDelivery.adoptOpened,
      onUnopened: (sessionId) => this.tabs.markUnopened(sessionId)
    })
    this.eventRecovery = new StructuredAgentSessionEventRecovery({
      deps,
      store: deps.store,
      sessions: this.sessions,
      flushLifecycle: (sessionId) => this.runtimeState.lifecycleBarrier(sessionId),
      publishStatus: this.clientDelivery.publishStatusAndSettlement,
      generationEnded: this.clientDelivery.publishGenerationEnded,
      serialize: (sessionId, task) => this.tasks.trackAttach(this.serialize(sessionId, task)),
      now: () => this.now(),
      runtimeState: this.runtimeState,
      wakeDelivery: (sessionId) => this.conversationDelivery.loop.wake(sessionId),
      stopStartingChild: (...args) => this.lifetime.stopStartingChild(...args),
      failStartingChild: (...args) => this.lifetime.failStartingChild(...args),
      trackOpen: (open) => this.tasks.trackAttach(open)
    })
    this.restartResume = createStructuredAgentSessionRestartResume(deps, this.sessions, {
      ...structuredAgentSessionRestartResumeSurfaces(this, this.now),
      readChildWork: this.clientDelivery.readChildWork,
      childWorkOpen: this.clientDelivery.childWorkOpen,
      publishStatus: this.clientDelivery.publishStatusAndSettlement
    })
    this.lifetime = lifetime.createStructuredAgentSessionConversationLifetime({
      context: () => this.lifetimeContext(),
      sessions: this.sessions,
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      open: (sessionId) => this.conversationDelivery.open(sessionId),
      // In-flight starts count as execution before a child is indexed.
      deliveryActive: (id) =>
        this.conversationDelivery.loop.isRunning(id) || this.runtimeState.startFlights.has(id),
      closeStatus: (sessionId, options) => this.clientDelivery.closeSession(sessionId, options),
      childWorkOpen: this.clientDelivery.childWorkOpen
    })
    this.runtimeState.startLeaseRenewal()
    this.lifetime.idleSweep.start()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)
  loadedSessionIds = (): string[] =>
    [...this.sessions].flatMap(([sessionId, { child }]) => (child ? [sessionId] : []))
  hasLoadedProviders = (): boolean => this.loadedSessionIds().length > 0
  sessionAgent = (sessionId: string) => this.deps.store.getRecord(sessionId)?.provider ?? null

  handleAdapterEvent = (event: Parameters<StructuredAgentSessionEventRecovery['handle']>[0]) =>
    this.eventRecovery.handle(event)

  // Keep inference so publishStatus stays required in the attach-context spread.
  private lifetimeContext() {
    return {
      deps: this.deps,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      now: () => this.now(),
      publishStatus: this.clientDelivery.publishStatus,
      generationEnded: this.clientDelivery.publishGenerationEnded,
      wakeDelivery: (sessionId: string) => this.conversationDelivery.loop.wake(sessionId),
      endExitedChild: this.eventRecovery.endExitedChildUnderSerialize
    } satisfies StructuredAgentSessionLifetimeContext
  }

  private attachContext(): StructuredAgentSessionAttachContext {
    return {
      ...this.lifetimeContext(),
      subscribers: this.subscribers,
      tasks: this.tasks,
      reconcileLeases: (sessionId) => this.reconcileLeases(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      openProviderChild: this.eventRecovery.openProviderChild,
      openConversation: this.conversationDelivery.open
    }
  }
  /** Release resources; user-close cancels cut turns, while eviction leaves their failure reportable. */
  close: lifetime.StructuredAgentSessionConversationLifetime['close'] = (sessionId, cause) =>
    this.lifetime.close(sessionId, cause)

  /** Stop hidden children too, using one bounded host snapshot. */
  sleepWorkspace = (workspaceId: string, markAsleep?: boolean) =>
    sleepStructuredAgentSessionWorkspace(
      {
        deps: this.deps,
        tasks: this.tasks,
        lifetime: this.lifetime,
        sessions: this.sessions,
        // Starts registered after Stop are newer work.
        deliveryRunning: (id) =>
          this.conversationDelivery.loop.isRunning(id) || this.runtimeState.startFlights.has(id),
        childWorkIncomplete: this.clientDelivery.childWorkIncomplete,
        publishRecordNotes: this.clientDelivery.publishRecordNotes
      },
      workspaceId,
      markAsleep
    )

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    providerSupport.adapterSupportsCreate(this.deps.adapter, location, agent)

  agentDefinitions = () => this.deps.agents.definitions()

  knownAgentIds = (): readonly string[] => providerSupport.knownAgentIds(this.deps)

  private readonly tabs = createTabs(this, this.sessions, this.clientDelivery.forgetStatus)
  listSessionTabs = this.tabs.listSessionTabs
  getPersistedVisibleSessionTabIndex = this.tabs.getPersistedVisibleSessionTabIndex
  getSessionTabId = this.tabs.getSessionTabId
  showSessionTabs = this.tabs.showSessionTabs
  setSessionTabVisibility = this.tabs.setSessionTabVisibility
  notifySessionTabHidden = this.tabs.notifySessionTabHidden
  /** Includes unreadable chat records. */
  holdsSessions = (): boolean => this.deps.store.holdsRecords()
  onSessionsHeld = (listener: () => void): (() => void) => this.deps.store.onFirstRecord(listener)

  reconcileRestartLeases = (): Promise<void> => this.restore.reconcileRestartLeases()

  restoreReadableSessions = (sessionIds?: readonly string[]): Promise<void> =>
    this.restore.restoreReadableSessions(sessionIds)

  revealSession = (sessionId: string): Promise<HostTypes.StructuredAgentSessionReveal> =>
    reveal.revealStructuredAgentSession(this.deps, sessionId, this.lifetime.conversation)

  private serialize = this.tasks.serialize.bind(this.tasks)

  private readonly entry = structuredAgentSessionEntryDelegates(() => this.attachContext())
  attach = this.entry.attach
  create = this.entry.create

  /** Test-only barrier for streamed event writes. */
  flushStreamedEvents = (id: string): Promise<void> => this.runtimeState.flushEventSink(id)

  /** Quit stops delivery and queued-card handover. */
  stopDelivery = () => [this.conversationDelivery, this.queued.drain].forEach((d) => d.dispose())

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

  private mutationContext = (): StructuredAgentSessionMutationContext =>
    createStructuredAgentSessionHostMutationContext({
      deps: this.deps,
      sessions: this.sessions,
      subscribers: this.subscribers,
      lifetime: this.lifetime,
      clientDelivery: this.clientDelivery,
      conversationDelivery: this.conversationDelivery,
      queued: this.queued,
      runtimeState: this.runtimeState,
      attachContext: () => this.attachContext(),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now()
    })

  send = this.conversationCommands.send

  queuedMessageSend = this.queued.queuedMessageSend
  queuedMessageDelete = this.queued.queuedMessageDelete
  queuedMessagesResume = this.queued.queuedMessagesResume
  queuedMessageUpdate = this.queued.queuedMessageUpdate
  queuedMessageEditHold = this.queued.queuedMessageEditHold

  waitForSendSettlement = this.clientDelivery.waitForSendSettlement

  private mutations = structuredAgentSessionMutationDelegates(() => this.mutationContext())
  cancel = this.mutations.cancel
  respondToPrompt = this.mutations.respondToPrompt
  setOption = this.mutations.setOption
  changeThreadGoal = this.mutations.changeThreadGoal
  readOptions = this.mutations.readOptions

  rewind = (caller: HostTypes.StructuredAgentSessionCaller, params: AgentSessionRewindParams) =>
    rewindStructuredAgentSession(this.mutationContext(), this.attachContext(), caller, params)

  conversationCommand = this.conversationCommands.run
  /** Undefined means unavailable; an empty array is an authoritative catalog. */
  readCommands = async (sessionId: string) => ({
    commands: await this.clientDelivery.readCommandsSettled(sessionId)
  })

  /** Read the store; idle-released chats have no session-map entry. */
  handoffStatus = (sessionId: string) => structuredAgentSessionOwnerStatus(this.deps, sessionId)

  history: StructuredAgentSessionBackgroundTaskChannel['history'] = (request, scope) =>
    this.backgroundTasks.history(request, scope)

  /** Full reduction: absence from a bounded page cannot prove a revised/tombstoned item is absent. */
  journalSnapshot = async (sessionId: string) =>
    (await this.lifetime.conversation(sessionId)).journal.snapshot()

  currentWork = this.clientDelivery.readCurrentWork
  readCurrentRequests: StructuredAgentSessionBackgroundTaskChannel['currentRequests'] = (...args) =>
    this.backgroundTasks.currentRequests(...args)

  subscribe = (input: AgentSessionSubscribeInput) => this.backgroundTasks.subscribe(input)

  settleLateDispatch = this.mutations.settleLateDispatch
  /** Republish row-free changes to held work. */
  publishWorkChanged: (sessionId: string) => void = this.clientDelivery.publishGenerationEnded

  publishChildWorkEvidence = this.clientDelivery.publishChildWork
  unsubscribe = (sessionId: string, id: string): void => this.subscribers.close(sessionId, id)

  /** Retains no per-session subscription. */
  subscribeStatus = this.clientDelivery.subscribeStatus
  publishConversationName = this.clientDelivery.publishConversationName
  regenerateConversationName = (sessionId: string): boolean =>
    this.deps.conversationNaming?.regenerate(sessionId) ?? false

  /** Live-only completion/prompt events; missed events are never replayed. */
  subscribeTurnCompletions = this.clientDelivery.subscribeTurnCompletions
  readStatusSummary = this.clientDelivery.readStatusSummary

  collaboratorsForTests = () => ({
    sessions: this.sessions,
    subscribers: this.subscribers,
    runtimeState: this.runtimeState,
    conversationDelivery: this.conversationDelivery,
    lifetime: this.lifetime,
    serialize: this.serialize
  })
}
