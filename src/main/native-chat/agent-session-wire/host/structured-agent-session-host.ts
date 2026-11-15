import * as usageLimit from '../recovery/structured-agent-session-host-background'
import { createStructuredAgentSessionConversationReads } from './structured-agent-session-conversation-reads'
import { continuationContextReader as contextReader } from '../recovery/structured-agent-session-continuation-context'
import { structuredAgentStartJournal } from '../acquisition/structured-agent-start-journal'
import { StructuredConversationCommandController as CommandController } from '../operations/structured-conversation-command-controller'

import { createStartupRecovery } from '../recovery/structured-agent-session-restart-reconcile'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { structuredAgentSessionEntryDelegates } from '../acquisition/structured-agent-session-entry-delegates'
import { claimStructuredAgentSessionAgent as claimAgent } from '../startup/structured-agent-session-agent-start'
import * as mutationWiring from './structured-agent-session-host-mutation-wiring'
import * as lifetime from '../termination/structured-agent-session-conversation-lifetime'
import { createStructuredAgentSessionTabSurface as createTabs } from './structured-agent-session-host-tabs'
import { flushStructuredAgentSessionHost } from '../termination/structured-agent-session-host-teardown'
import type * as HostTypes from './structured-agent-session-host-types'
import { StructuredAgentSessionEventRecovery as EventRecovery } from '../termination/structured-agent-session-event-recovery'
import { StructuredAgentSessionBackgroundTaskChannel as BackgroundTasks } from '../publication/subscribers/structured-agent-session-background-task-channel'
import { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import { createStructuredAgentSessionPublicationWiring } from './structured-agent-session-publication-wiring'
import * as resume from '../recovery/structured-agent-session-restart-resume-host'
import type { StructuredAgentSessionRestartResume } from '../recovery/structured-agent-session-restart-resume-contract'
import { structuredAgentSessionRestartResumeSurfaces } from '../recovery/structured-agent-session-restart-resume-wiring'
import * as conversation from '../delivery/structured-agent-session-host-delivery'
import { wireStructuredAgentSessionQueuedMessages as wireQueuedMessages } from '../delivery/structured-agent-session-queued-wiring'
import * as sessionLogger from './structured-agent-session-logger'
import { createStructuredAgentSessionWorkspaceSleeper } from '../termination/structured-agent-session-workspace-sleep'

export class StructuredAgentSessionHost {
  private readonly conversationCommands = new CommandController(() => this.mutationContext(), this)
  private readonly sessions = createStructuredAgentSessionPublicationWiring({
    client: () => this.clientDelivery,
    delivery: () => this.conversationDelivery,
    opened: (id) => usageLimit.opened(this.usageLimitContinue, this.queued, id),
    workChanged: (id) => this.runtimeState.refreshActivity(id),
    logger: () => this.deps.logger,
    now: () => this.now(),
    observeRows: () => this.deps.observeCommittedRows
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
    this.sessions,
    (sessionId, cut) => this.usageLimitContinue?.readState(sessionId, cut),
    (sessionId) => this.runtimeState?.currentEventSink(sessionId)?.liveText() ?? []
  )
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly startup: ReturnType<typeof createStartupRecovery>
  readonly reconcileRestartLeases = () => this.startup.reconcileRestartLeases()
  private readonly lifetime: HostTypes.StructuredAgentSessionConversationLifetime
  private readonly conversationDelivery: conversation.StructuredAgentSessionConversationDelivery
  private readonly eventRecovery: EventRecovery
  private readonly backgroundTasks: BackgroundTasks
  readonly restartResume: StructuredAgentSessionRestartResume

  readonly usageLimitContinue: ReturnType<typeof usageLimit.start>

  constructor(readonly deps: HostTypes.StructuredAgentSessionHostDeps) {
    // Collaborators share a logger wrapper that cannot fail the operation it reports.
    this.deps = deps = sessionLogger.withNeverThrowingLogger(deps)
    this.clientDelivery.watchAtRestCommands(deps.adapter)
    this.backgroundTasks = new BackgroundTasks(
      deps,
      this.sessions,
      this.clientDelivery.subscribers,
      (sessionId) => this.lifetime.conversation(sessionId),
      this.clientDelivery.readCurrentWork,
      this.clientDelivery.readChildWork,
      this.clientDelivery.childWorkIncomplete
    )
    this.runtimeState = new StructuredAgentSessionHostRuntimeState(
      deps,
      this.sessions,
      (id, e) => this.eventRecovery.recoverAfterSinkFailure(id, e),
      (expired) => this.lifetime.expireStartup(expired),
      (id) => this.conversationDelivery?.loop.isRunning(id) ?? false,
      this.clientDelivery
    )
    this.conversationDelivery = conversation.createStructuredAgentSessionConversationDelivery({
      deps,
      acquireAborts: this.runtimeState.acquireAborts,
      sessions: this.sessions,
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      // Quit drains tracked starts before eviction so their children are stopped.
      trackStart: (start) => this.tasks.trackAttach(start),
      startProviderChild: (id, startedFor) => claimAgent(this.attachContext(), id, startedFor),
      deliveryOrder: this.runtimeState.deliveryOrder,
      startFlights: this.runtimeState.startFlights,
      readiness: (id, child) => this.runtimeState.startupAttempts.readiness(id, child),
      // Retire at rest; the next start refreshes login and permission mode.
      stopOutgrownAgent: (id) => this.lifetime.stopAgent(id, { cause: 'evict', resting: true }),
      stopPermissionTransitionChild: (id) => this.lifetime.stopAgent(id, { cause: 'evict' }),
      clientDelivery: this.clientDelivery
    })
    this.startup = createStartupRecovery(deps, this.runtimeState.reconcileLeases, this.runtimeState)
    this.eventRecovery = new EventRecovery({
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
      deliveryActive: (id) => this.runtimeState.hasDeliveryWork(id),
      closeStatus: (sessionId, options) => this.clientDelivery.closeSession(sessionId, options),
      childWorkOpen: this.clientDelivery.childWorkOpen
    })
    this.continuationContext = contextReader(deps, this.lifetime.conversation)
    this.usageLimitContinue = usageLimit.start(this.mutationContext(), this, this.clientDelivery)
    this.runtimeState.startLeaseRenewal()
    this.lifetime.idleSweep.start()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)
  loadedSessionIds = this.sessions.loadedSessionIds
  hasLoadedProviders = (): boolean => this.loadedSessionIds().length > 0
  private readonly reads = createStructuredAgentSessionConversationReads(() => ({
    ...this.lifetimeContext(),
    serialize: this.serialize,
    seal: (id) => this.runtimeState.sealEventSink(id),
    readCommands: this.clientDelivery.readCommandsSettled,
    conversation: (sessionId) => this.lifetime.conversation(sessionId)
  }))
  sessionAgent = this.reads.sessionAgent
  attentionReads = this.reads.attentionReads
  readModelCatalog = this.reads.readModelCatalog
  childAccountHome = this.reads.childAccountHome
  prospectiveAccountHome = this.reads.prospectiveAccountHome

  handleAdapterEvent = (e: Parameters<EventRecovery['handle']>[0]) => this.eventRecovery.handle(e)

  // Keep inference so publishStatus stays required in the attach-context spread.
  private lifetimeContext = () =>
    ({
      deps: this.deps,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      now: () => this.now(),
      publishStatus: this.clientDelivery.publishStatus,
      generationEnded: this.clientDelivery.publishGenerationEnded,
      wakeDelivery: (sessionId: string) => this.conversationDelivery.loop.wake(sessionId),
      endExitedChild: this.eventRecovery.endExitedChildUnderSerialize
    }) satisfies HostTypes.StructuredAgentSessionLifetimeContext

  private attachContext = (): HostTypes.StructuredAgentSessionAttachContext => ({
    ...this.lifetimeContext(),
    subscribers: this.clientDelivery.subscribers,
    tasks: this.tasks,
    reconcileLeases: (sessionId) => this.runtimeState.reconcileLeases(sessionId),
    serialize: (sessionId, task) => this.serialize(sessionId, task),
    openProviderChild: this.eventRecovery.openProviderChild,
    openConversation: this.conversationDelivery.open
  })
  /** Release resources; user-close cancels cut turns, while eviction leaves their failure reportable. */
  close: typeof this.lifetime.close = (...args) => this.lifetime.close(...args)

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

  serializeCreateIntent = this.tasks.serializeCreateIntent.bind(this.tasks)

  supportsCreate = this.reads.supportsCreate
  agentDefinitions = this.reads.agentDefinitions
  knownAgentIds = this.reads.knownAgentIds

  private readonly tabs = createTabs(this, this.sessions, this.clientDelivery, (ids) =>
    this.startup.recover(ids)
  )
  listSessionTabs = this.tabs.listSessionTabs
  isSessionTabVisible = this.tabs.isSessionTabVisible
  getPersistedVisibleSessionTabIndex = this.tabs.getPersistedVisibleSessionTabIndex
  getSessionTabId = this.tabs.getSessionTabId
  showSessionTabs = this.tabs.showSessionTabs
  setSessionTabVisibility = this.tabs.setSessionTabVisibility
  notifySessionTabHidden = this.tabs.notifySessionTabHidden
  /** Includes unreadable chat records. */
  holdsSessions = this.reads.holdsSessions
  onSessionsHeld = this.reads.onSessionsHeld

  seedSessionTabs = this.tabs.seedSessionTabs

  drainStatusWrites = this.clientDelivery.drainStatusWrites

  revealSession = this.reads.revealSession

  private serialize = this.tasks.serialize.bind(this.tasks)
  withForkSourceAdmission = this.serialize

  private readonly entry = structuredAgentSessionEntryDelegates(() => this.attachContext())
  attach = this.entry.attach
  create = this.entry.create

  /** Test-only barrier for streamed event writes. */
  flushStreamedEvents = (id: string) => this.runtimeState.flushEventSink(id)

  /** Quit stops delivery and queued-card handover. */
  stopDelivery = () => {
    this.sessions.endPublications()
    ;[this.conversationDelivery, this.queued.drain].forEach((d) => d.dispose())
    this.usageLimitContinue.dispose()
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
    mutationWiring.createStructuredAgentSessionHostMutationContext({
      deps: this.deps,
      sessions: this.sessions,
      subscribers: this.clientDelivery.subscribers,
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

  private mutations = mutationWiring.structuredAgentSessionMutationDelegates(
    () => this.mutationContext(),
    () => this.attachContext()
  )
  cancel = this.mutations.cancel
  respondToPrompt = this.mutations.respondToPrompt
  setOption = this.mutations.setOption
  changeThreadGoal = this.mutations.changeThreadGoal
  readOptions = this.mutations.readOptions

  rewind = this.mutations.rewind

  conversationCommand = this.conversationCommands.run
  readCommands = this.reads.readCommands

  handoffStatus = (sessionId: string) => this.backgroundTasks.handoffStatus(sessionId)

  history: BackgroundTasks['history'] = (...args) => this.backgroundTasks.history(...args)

  readonly continuationContext: ReturnType<typeof contextReader>

  observeConversationPublications = this.sessions.observeConversationPublications
  forkBoundary: BackgroundTasks['forkBoundary'] = (...a) => this.backgroundTasks.forkBoundary(...a)
  savedContent = (sessionId: string) => this.backgroundTasks.savedContent(sessionId)
  historyItem = (id: string, itemId: string) => this.backgroundTasks.historyItem(id, itemId)
  conversationOutline = (sessionId: string) => this.backgroundTasks.conversationOutline(sessionId)
  namingPrompt = this.reads.namingPrompt
  approvalPrompt = this.reads.approvalPrompt
  automationRun = this.reads.automationRun
  queuedSendAnswer = this.reads.queuedSendAnswer
  sendAnswer = this.reads.sendAnswer
  mailObservation = this.reads.mailObservation
  holdMailSources = this.reads.holdMailSources
  wakeQueuedMessages = (sessionId: string) => this.queued.refresh(sessionId)

  private readonly startJournal = structuredAgentStartJournal(
    () => this.deps,
    (sessionId) => this.lifetime.conversation(sessionId)
  )
  captureAgentStartDestination = this.startJournal.captureAgentStartDestination
  appendAgentStart = this.startJournal.appendAgentStart

  currentWork = this.clientDelivery.readCurrentWork
  currentWorkAtRest = this.reads.currentWorkAtRest
  readCurrentRequests: BackgroundTasks['currentRequests'] = (...args) =>
    this.backgroundTasks.currentRequests(...args)

  observeJournalPublications = this.clientDelivery.observeJournalPublications

  subscribe: BackgroundTasks['subscribe'] = (input) => this.backgroundTasks.subscribe(input)

  settleLateDispatch = this.mutations.settleLateDispatch
  publishWorkChanged: (sessionId: string) => void = this.clientDelivery.publishGenerationEnded

  publishChildWorkEvidence = this.clientDelivery.publishChildWork
  unsubscribe = (id: string, key: string): void => this.clientDelivery.subscribers.close(id, key)

  subscribeStatus = this.clientDelivery.subscribeStatus
  publishConversationName = this.clientDelivery.publishConversationName
  regenerateConversationName = this.reads.regenerateConversationName
  setUserConversationName = this.reads.setUserConversationName

  subscribeTurnCompletions = this.clientDelivery.subscribeTurnCompletions
  readStatusSummary = this.clientDelivery.readStatusSummary

  collaboratorsForTests = () => ({
    sessions: this.sessions,
    subscribers: this.clientDelivery.subscribers,
    runtimeState: this.runtimeState,
    conversationDelivery: this.conversationDelivery,
    lifetime: this.lifetime,
    serialize: this.serialize
  })
}
