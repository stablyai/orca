import { structuredAgentSessionSwitchSource } from './structured-agent-session-switch-source'
import { continuationContextReader as contextReader } from './structured-agent-session-continuation-context'
import { structuredAgentStartJournal } from './structured-agent-start-journal'
import type { AgentSessionRewindParams } from '../../../shared/agent-session-rewind'
import { rewindStructuredAgentSession } from './structured-agent-session-rewind'
import { StructuredConversationCommandController } from './structured-conversation-command-controller'
import type { AgentSessionSubscribeInput } from './structured-agent-session-subscribers'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import { createStartupRecovery } from './structured-agent-session-restart-reconcile'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import * as reveal from './structured-agent-session-reveal'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { structuredAgentSessionEntryDelegates } from './structured-agent-session-create'
import * as agentStart from './structured-agent-session-agent-start'
import * as lifetime from './structured-agent-session-conversation-lifetime'
import { createStructuredAgentSessionTabSurface as createTabs } from './structured-agent-session-host-tabs'
import * as hostMutations from './structured-agent-session-host-mutations'
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
import { StructuredAgentSessionHostContexts } from './structured-agent-session-host-contexts'
import {
  agentSessionSwitchDeadline,
  type AgentSessionSwitchDeadline
} from '../../../shared/agent-session-switch-execution'
// Serialize durable mutations per conversation; open at rest and start a child only when work needs it.

export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export class StructuredAgentSessionHost extends StructuredAgentSessionHostContexts {
  private readonly conversationCommands = new StructuredConversationCommandController(
    () => this.mutationContext(),
    this
  )
  protected readonly sessions = createStructuredAgentSessionPublicationWiring({
    client: () => this.clientDelivery,
    delivery: () => this.conversationDelivery,
    opened: (id) => this.queued.onOpened(id),
    logger: () => this.deps.logger,
    now: () => this.now()
  })
  protected readonly queued = wireQueuedMessages(this.sessions, () => this.mutationContext())
  // Journal publication renews idle activity.
  protected readonly clientDelivery = new StructuredAgentSessionClientDelivery(
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
  protected readonly subscribers = this.clientDelivery.subscribers
  protected readonly tasks = new StructuredAgentSessionTaskQueue()
  protected readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly startup: ReturnType<typeof createStartupRecovery>
  readonly reconcileRestartLeases = () => this.startup.reconcileRestartLeases()
  protected readonly lifetime: lifetime.StructuredAgentSessionConversationLifetime
  protected readonly conversationDelivery: conversation.StructuredAgentSessionConversationDelivery
  protected readonly eventRecovery: StructuredAgentSessionEventRecovery
  private readonly backgroundTasks: BackgroundTasks
  readonly restartResume: resume.StructuredAgentSessionRestartResume

  constructor(readonly deps: HostTypes.StructuredAgentSessionHostDeps) {
    super()
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

  protected now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)
  loadedSessionIds = (): string[] =>
    [...this.sessions].flatMap(([sessionId, { child }]) => (child ? [sessionId] : []))
  hasLoadedProviders = (): boolean => this.loadedSessionIds().length > 0
  sessionAgent = (sessionId: string) => this.deps.store.getConversation(sessionId)?.provider ?? null

  handleAdapterEvent = (event: Parameters<StructuredAgentSessionEventRecovery['handle']>[0]) =>
    this.eventRecovery.handle(event)

  /** Release resources; user-close cancels cut turns, while eviction leaves their failure reportable. */
  close: lifetime.StructuredAgentSessionConversationLifetime['close'] = (sessionId, cause, admit) =>
    this.lifetime.close(sessionId, cause, admit)
  switchToTerminal = async (sessionId: string, deadline?: AgentSessionSwitchDeadline) => {
    const budget = deadline ?? agentSessionSwitchDeadline()
    try {
      await this.stopForSwitch(sessionId, { callerKey: 'trusted-local:session-switch' }, budget)
    } finally {
      if (!deadline) {
        budget.dispose()
      }
    }
  }
  runSwitch: lifetime.StructuredAgentSessionConversationLifetime['runSwitch'] = (...args) =>
    this.lifetime.runSwitch(...args)
  adoptSwitch = (from: string, to: string) => this.lifetime.adoptSwitch(from, to)
  switchGeneration = (id: string) => this.lifetime.switchGeneration(id)
  guardSwitchWork = (id: string, current: () => boolean) =>
    this.lifetime.guardSwitchWork(id, current)
  trackSwitchPhysical = <T>(id: string, work: Promise<T>) =>
    this.lifetime.trackSwitchPhysical(id, work)

  /** Ordinary Stop owns interruption; only its captured child may be physically closed. */

  private switchSource = () =>
    structuredAgentSessionSwitchSource({
      deps: this.deps,
      cancel: this.cancel,
      switchGeneration: this.switchGeneration,
      guardSwitchWork: this.guardSwitchWork,
      currentWork: this.currentWork,
      startFlights: this.runtimeState.startFlights,
      now: this.now,
      lifetime: this.lifetime,
      sessions: this.sessions,
      serialize: this.serialize,
      subscribers: this.subscribers
    })
  stopForSwitch = (
    ...args: Parameters<ReturnType<typeof structuredAgentSessionSwitchSource>['stopForSwitch']>
  ) => this.switchSource().stopForSwitch(...args)
  refreshSwitchTranscript = (
    ...args: Parameters<
      ReturnType<typeof structuredAgentSessionSwitchSource>['refreshSwitchTranscript']
    >
  ) => this.switchSource().refreshSwitchTranscript(...args)
  captureSwitchWork = (
    ...args: Parameters<ReturnType<typeof structuredAgentSessionSwitchSource>['captureSwitchWork']>
  ) => this.switchSource().captureSwitchWork(...args)

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

  protected serialize = this.tasks.serialize.bind(this.tasks)

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

  send = this.conversationCommands.send

  queuedMessageSend = this.queued.queuedMessageSend
  queuedMessageDelete = this.queued.queuedMessageDelete
  queuedMessageMove = this.queued.queuedMessageMove
  queuedMessagesResume = this.queued.queuedMessagesResume
  queuedMessageUpdate = this.queued.queuedMessageUpdate
  queuedMessageEditHold = this.queued.queuedMessageEditHold

  waitForSendSettlement = this.clientDelivery.waitForSendSettlement

  private mutations = hostMutations.structuredAgentSessionMutationDelegates(() =>
    this.mutationContext()
  )
  cancel = this.mutations.cancel
  respondToPrompt = this.mutations.respondToPrompt
  setOption = this.mutations.setOption
  changeThreadGoal = this.mutations.changeThreadGoal
  readOptions = this.mutations.readOptions
  /** A terminal's conversation moves into this chat: its agent starts and is ready, or why not. */
  switchToChat = this.mutations.switchToChat
  openSwitchToChat = this.mutations.openSwitchToChat

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
