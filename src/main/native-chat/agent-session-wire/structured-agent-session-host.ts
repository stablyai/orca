import { continuationContextReader as contextReader } from './structured-agent-session-continuation-context'
import { structuredAgentStartJournal } from './structured-agent-start-journal'
import type { AgentSessionRewindParams } from '../../../shared/agent-session-rewind'
import { rewindStructuredAgentSession } from './structured-agent-session-rewind'
import { StructuredConversationCommandController } from './structured-conversation-command-controller'
// Serialize durable mutations per conversation; open at rest and start a child only when work needs it.

import type { AgentSessionSubscribeInput } from './structured-agent-session-subscribers'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import { createStartupRecovery } from './structured-agent-session-restart-reconcile'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import * as reveal from './structured-agent-session-reveal'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { structuredAgentSessionEntryDelegates } from './structured-agent-session-create'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import * as agentStart from './structured-agent-session-agent-start'
import { createStructuredAgentSessionHostMutationContext } from './structured-agent-session-host-mutation-wiring'
import * as lifetime from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { createStructuredAgentSessionTabSurface as createTabs } from './structured-agent-session-host-tabs'
import { structuredAgentSessionMutationDelegates } from './structured-agent-session-host-mutations'
import { flushStructuredAgentSessionHost } from './structured-agent-session-host-teardown'
import type * as HostTypes from './structured-agent-session-host-types'
import { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import { StructuredAgentSessionBackgroundTaskChannel as BackgroundTasks } from './structured-agent-session-background-task-channel'
import { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import { createStructuredAgentSessionPublicationWiring } from './structured-agent-session-publication-wiring'
import * as resume from './structured-agent-session-restart-resume-host'
import { structuredAgentSessionRestartResumeSurfaces } from './structured-agent-session-restart-resume-wiring'
import * as conversation from './structured-agent-session-host-delivery'
import { wireStructuredAgentSessionQueuedMessages as wireQueuedMessages } from './structured-agent-session-queued-wiring'
import * as sessionLogger from './structured-agent-session-logger'
import { createStructuredAgentSessionWorkspaceSleeper } from './structured-agent-session-workspace-sleep'
export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export class StructuredAgentSessionHost {
  private readonly conversationCommands = new StructuredConversationCommandController(
    () => this.mutationContext(),
    this
  )
  private readonly sessions = createStructuredAgentSessionPublicationWiring({
    client: () => this.clientDelivery,
    delivery: () => this.conversationDelivery,
    opened: (id) => this.queued.onOpened(id),
    logger: () => this.deps.logger,
    now: () => this.now()
  })
  private readonly queued = wireQueuedMessages(this.sessions, () => this.mutationContext())
  // Journal publication renews idle activity.
  private readonly clientDelivery = new StructuredAgentSessionClientDelivery(
    this.sessions,
    () => this.now(),
    () => this.deps,
    this.queued,
    (sessionId) => this.restartResume.onAgentStarted(sessionId),
    (sessionId) => this.backgroundTasks.publish(sessionId),
    (sessionId) => this.backgroundTasks.read(sessionId),
    (sessionId) => this.runtimeState?.startFlights.projectsStarting(sessionId) ?? false,
    this.sessions
  )
  private readonly subscribers = this.clientDelivery.subscribers
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly startup: ReturnType<typeof createStartupRecovery>
  readonly reconcileRestartLeases = () => this.startup.reconcileRestartLeases()
  private readonly lifetime: lifetime.StructuredAgentSessionConversationLifetime
  private readonly conversationDelivery: conversation.StructuredAgentSessionConversationDelivery
  private readonly eventRecovery: StructuredAgentSessionEventRecovery
  private readonly backgroundTasks: BackgroundTasks
  readonly restartResume: resume.StructuredAgentSessionRestartResume

  constructor(readonly deps: HostTypes.StructuredAgentSessionHostDeps) {
    // Collaborators share a logger wrapper that cannot fail the operation it reports.
    this.deps = deps = sessionLogger.withNeverThrowingLogger(deps)
    this.clientDelivery.watchAtRestCommands(deps.adapter)
    this.backgroundTasks = new BackgroundTasks(
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
      startFlights: this.runtimeState.startFlights,
      readiness: (id, child) => this.runtimeState.startupAttempts.readiness(id, child),
      // Retire at rest; the next start refreshes login and permission mode.
      stopOutgrownAgent: (id) => this.lifetime.stopAgent(id, { cause: 'evict', resting: true }),
      clientDelivery: this.clientDelivery
    })
    this.startup = createStartupRecovery(deps, this.runtimeState.reconcileLeases, this.runtimeState)
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
    this.restartResume = resume.createStructuredAgentSessionRestartResume(deps, this.sessions, {
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
    this.continuationContext = contextReader(deps, this.lifetime.conversation)
    this.runtimeState.startLeaseRenewal()
    this.lifetime.idleSweep.start()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)
  loadedSessionIds = this.sessions.loadedSessionIds
  hasLoadedProviders = (): boolean => this.loadedSessionIds().length > 0
  sessionAgent = (sessionId: string) => this.deps.store.getConversation(sessionId)?.provider ?? null

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
      reconcileLeases: (sessionId) => this.runtimeState.reconcileLeases(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      openProviderChild: this.eventRecovery.openProviderChild,
      openConversation: this.conversationDelivery.open
    }
  }
  /** Release resources; user-close cancels cut turns, while eviction leaves their failure reportable. */
  close: lifetime.StructuredAgentSessionConversationLifetime['close'] = (sessionId, cause, admit) =>
    this.lifetime.close(sessionId, cause, admit)

  /** Stop hidden children too, using one bounded host snapshot. */
  sleepWorkspace = createStructuredAgentSessionWorkspaceSleeper(() => ({
    deps: this.deps,
    tasks: this.tasks,
    lifetime: this.lifetime,
    sessions: this.sessions,
    conversationDelivery: this.conversationDelivery,
    runtimeState: this.runtimeState,
    clientDelivery: this.clientDelivery
  }))

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    providerSupport.adapterSupportsCreate(this.deps.adapter, location, agent)

  agentDefinitions = () => this.deps.agents.definitions()

  knownAgentIds = (): readonly string[] => providerSupport.knownAgentIds(this.deps)

  private readonly tabs = createTabs(
    this,
    this.sessions,
    this.clientDelivery.forgetStatus,
    this.clientDelivery.publishSavedStatusGroup,
    (ids) => this.startup.recover(ids)
  )
  listSessionTabs = this.tabs.listSessionTabs
  isSessionTabVisible = this.tabs.isSessionTabVisible
  getPersistedVisibleSessionTabIndex = this.tabs.getPersistedVisibleSessionTabIndex
  getSessionTabId = this.tabs.getSessionTabId
  showSessionTabs = this.tabs.showSessionTabs
  setSessionTabVisibility = this.tabs.setSessionTabVisibility
  notifySessionTabHidden = this.tabs.notifySessionTabHidden
  /** Includes unreadable chat records. */
  holdsSessions = (): boolean => this.deps.store.holdsRecords()
  onSessionsHeld = (listener: () => void): (() => void) => this.deps.store.onFirstRecord(listener)

  seedSessionTabs = this.tabs.seedSessionTabs

  drainStatusWrites = (): Promise<void> => this.clientDelivery.drainStatusWrites()

  revealSession = (sessionId: string): Promise<HostTypes.StructuredAgentSessionReveal> =>
    reveal.revealStructuredAgentSession(this.deps, sessionId, this.lifetime.conversation)

  private serialize = this.tasks.serialize.bind(this.tasks)

  private readonly entry = structuredAgentSessionEntryDelegates(() => this.attachContext())
  attach = this.entry.attach
  create = this.entry.create

  /** Test-only barrier for streamed event writes. */
  flushStreamedEvents = (id: string): Promise<void> => this.runtimeState.flushEventSink(id)

  /** Quit stops delivery and queued-card handover. */
  stopDelivery = () => {
    this.sessions.endPublications()
    ;[this.conversationDelivery, this.queued.drain].forEach((d) => d.dispose())
  }

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

  private mutationContext = () =>
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
      trackProviderOperation: (operation) => this.tasks.trackAttach(operation),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now()
    })

  send = this.conversationCommands.send

  queuedMessageSend = this.queued.queuedMessageSend
  queuedMessageDelete = this.queued.queuedMessageDelete
  queuedMessageMove = this.queued.queuedMessageMove
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
  readCommands = (sessionId: string, commandsOnRequest = false) =>
    this.clientDelivery.readCommandsSettled(sessionId, commandsOnRequest)

  /** Read the store; idle-released chats have no session-map entry. */
  handoffStatus = (sessionId: string) => this.backgroundTasks.handoffStatus(sessionId)

  history: BackgroundTasks['history'] = (...args) => this.backgroundTasks.history(...args)

  readonly continuationContext: ReturnType<typeof contextReader>

  observeConversationPublications: typeof this.sessions.observeConversationPublications = (
    ...args
  ) => this.sessions.observeConversationPublications(...args)
  journalSnapshot = (sessionId: string) => this.backgroundTasks.journalSnapshot(sessionId)
  queuedSendAnswer = (sessionId: string, messageId: string) =>
    this.backgroundTasks.queuedSendAnswer(sessionId, messageId)

  private readonly startJournal = structuredAgentStartJournal(
    () => this.deps,
    (sessionId) => this.lifetime.conversation(sessionId)
  )
  captureAgentStartDestination = this.startJournal.captureAgentStartDestination
  appendAgentStart = this.startJournal.appendAgentStart

  currentWork = this.clientDelivery.readCurrentWork
  readCurrentRequests: BackgroundTasks['currentRequests'] = (...args) =>
    this.backgroundTasks.currentRequests(...args)

  observeJournalPublications = this.clientDelivery.observeJournalPublications

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
  setUserConversationName: HostTypes.SetUserConversationName = (...args) =>
    this.deps.conversationNaming?.setUserName(...args) ?? Promise.resolve(null)

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
