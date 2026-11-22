import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import { chatMailPlace } from '../external-conversations/external-conversation-links'
import * as botGroups from '../bots/bot-group-runtime'
import * as botGroupRemote from '../bots/bot-group-remote-answers'
import { chatReplyFollowUp } from './rpc/methods/orchestration/messaging/reply-follow-up'
import type { SessionOptionValue } from '../../shared/native-chat/input/native-chat-session-options'
import { conversationRecordReader } from './orchestration/addressing/session-lineage/structured-session-lineage'
import { botSessionHooks } from '../bots/bot-turn-ended'
import type { RuntimeLinearCommandSurface } from './integrations/linear/runtime-linear-command-surface'
import { installRuntimeLinearCommandSurface } from './integrations/linear/runtime-linear-command-surface'
import { publishNativeChatPreferenceChanges } from './agent-session/launch/runtime-native-chat-preference-events'
import { publishSettingsChanges } from './client/settings/runtime-settings-change-events'
import {
  publishBotSidebarViewChanges,
  publishWorkspaceViewChanges
} from './client/settings/runtime-workspace-view-change-events'
import { syncPRAutoRefreshCadence } from '../github/pull-requests/refresh/pr-auto-refresh-cadence-sync'
import {
  OrcaRuntimeWithSidebarTemporal,
  sidebarFactsRuntime
} from './sidebar-inputs/orca-runtime-sidebar-temporal'
import { OrcaRuntimeWithAgentTransitions } from './construction/orca-runtime-agent-transitions'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-list/feed/sidebar-inputs-switch'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import type { RuntimeCommandSurfaceHost } from './construction/runtime-installed-command-surfaces'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch/contracts/agent-launch-tab-publication'
import type {
  AgentLaunchPaneAddress,
  AgentLaunchPaneVerdict
} from '../../shared/agent-launch/contracts/agent-launch-pane-verdict'
import { registerWorktreeChangeInvalidator } from '../ipc/worktrees/listing/worktree-change-invalidators'
import type { AgentSessionRecordStore } from './agent-session/records/agent-session-record-store'
import { peekOpenedAgentSessionRecordStore } from './agent-session/records/agent-session-record-store-slot'
import { createAgentLaunchRecordWarmupGate } from './construction/agent-launch-record-warmup-gate'
import * as WorkspaceLayouts from './terminal/surface/workspace-layout-stream'
import type { RemoteLayoutSnapshot } from '../../shared/remote-runtime/session-graph/remote-layout-snapshot'
import { registerDetectedWorktreeScanInvalidation } from '../ipc/worktrees/listing/register-detected-worktree-scan-invalidation'
import { WorkspaceReferenceQueries } from './runtime-workspace-reference-queries'
import { registerWorktreeCatalogRoutes } from './workspaces/catalog/worktree-catalog-live-route'
import {
  createReferenceAgentIndex,
  referenceConnectionHosts
} from './workspaces/references/runtime-reference-agents'
import type { RuntimeReferenceFindParams } from '../../shared/workspace-attachments/runtime-reference-contracts'
import type { LayoutApplyReply } from '../../shared/workspace-layout/workspace-layout-command-types'
import { rekeyMovedPaneOwners } from './terminal/identity/moved-pane-owner-rekey'
import * as Layout from './terminal/layout/runtime-layout-apply'
import type { TerminalCreateOptions } from './terminal/launch/terminal-create-options'
import {
  installStructuredAgentAvailability as installAvailability,
  type StructuredAgentAvailabilityReader as AvailabilityReader
} from './agent-session/launch/structured-agent-availability'
import { PairedServerRowsProducer } from './sidebar-inputs/workspace-rows/paired-server-rows-producer'
import { RepoIconDataUrls } from './sidebar-inputs/repo-icons/repo-icon-data-urls'
import { runtimeIconFetch } from './sidebar-inputs/repo-icons/repo-icon-remote-fetch'
import { WorkspaceRowsProducer } from './sidebar-inputs/workspace-rows/workspace-rows-producer'
import { getRuntimeDesktopSurface } from './construction/runtime-desktop-surface'
import { CollapseWriteOrder } from './client/settings/workspace-view-collapse-writes'
import { SidebarInputsFeed } from './sidebar-inputs/feed/sidebar-inputs-feed'
import { sidebarInputsFeedDomains } from './sidebar-inputs/sidebar-inputs-feed-domains'
import { requireSwitchedOn } from './construction/require-sidebar-inputs-enabled'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getHostDisplayLabelOverrides } from '../../shared/execution-host/host-setting-overrides'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import { continueRestoredWorkerMailSoon } from './rpc/methods/orchestration/messaging/settled-worker-follow-through'
import { scrubBotToolSecrets } from './rpc/methods/bots-tools'
import {
  PeerMailRelay,
  type PeerServerAnswerStatus
} from './orchestration/federation/peer-mail/peer-mail-relay'
import { structuredAgentSessionHostTabId } from '../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { runtimeBotChatTreeIndex } from '../bots/bot-chat-tree-host'

const OrcaRuntimeSidebarBase: typeof OrcaRuntimeWithAgentTransitions = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? OrcaRuntimeWithSidebarTemporal
  : OrcaRuntimeWithAgentTransitions

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- SAFETY: The existing Linear installer supplies the canonical prototype surface.
class OrcaRuntimeService extends OrcaRuntimeSidebarBase {
  protected override assertStructuredQueuedMessageAllowed(sessionId: string, messageId: string) {
    botGroups.assertBotGroupQueuedMessageAllowed(this, sessionId, messageId)
  }

  // Bot rules only for bot sessions; lazy, as the base builds its mail delivery first.
  protected override structuredMailOwner() {
    return botGroups.botMailOwner(this)
  }

  protected override structuredMailReplyFollowUp = chatReplyFollowUp(this)

  protected override chatConversationPlace(sessionId: string, from: AgentMessageSource) {
    return this.store ? chatMailPlace(this.store, sessionId, from) : null
  }

  protected override botGroupRoomMailArrived(groupId: string): void {
    botGroupRemote.remoteRoomMailArrived(botGroups.runtimeBotGroups(this), groupId)
  }

  protected override leaveBotGroups(botId: string): Promise<void> {
    return botGroups.runtimeBotGroups(this).removeBot(botId)
  }

  /** Moves a bot's saved tool values out of its folder and Claude's config before its CLI runs. */
  protected override scrubBotToolSecrets(bot: Parameters<typeof scrubBotToolSecrets>[1]) {
    return scrubBotToolSecrets(this, bot)
  }

  // Lazy: the database can open, and arm relays, while the runtime is still constructing.
  declare private peerMailRelay: PeerMailRelay | undefined

  override ensureOrchestrationFederationRelay(runId?: string, opt?: { keepAwake?: boolean }): void {
    super.ensureOrchestrationFederationRelay(runId, opt)
    this.ensureOrchestrationPeerMailRelay()
  }

  ensureOrchestrationPeerMailRelay(environmentId?: string): void {
    this.peerMailRelay ??= new PeerMailRelay(this, () => this.orchestrationEnvironmentTransport)
    this.peerMailRelay.ensure(environmentId)
  }

  /** What the pull loop last heard from a paired server, without asking it. */
  getPeerServerAnswerStatus(environmentId: string): PeerServerAnswerStatus | undefined {
    return this.peerMailRelay?.answerStatus(environmentId)
  }

  override stopOrchestrationFederationRelay(): void {
    super.stopOrchestrationFederationRelay()
    this.peerMailRelay?.stop()
  }

  /** Sidebar facts are absent unless ORCA_SIDEBAR_INPUTS=main. */
  get sidebarFacts() {
    return sidebarFactsRuntime(this)
  }
  // Idle without relay hosts; refresh only while a window or phone consumes sidebar state.
  readonly pairedServerRows = ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? new PairedServerRowsProducer({
        hasDemand: () =>
          this.sidebarInputsFeed?.subscribed === true ||
          (this.authoritativeWindowId !== null &&
            this.authoritativeWindowId !== HEADLESS_RUNTIME_WINDOW_ID &&
            this.store?.getUI?.().sidebarOpen !== false),
        hostLabelOverrides: () => getHostDisplayLabelOverrides(this.requireStore().getSettings())
      })
    : null
  readonly repoIconDataUrls = ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? new RepoIconDataUrls({
        repos: () => this.store?.getRepos() ?? [],
        fetch: runtimeIconFetch,
        encoder: () => getRuntimeDesktopSurface().encodeRepoIconPng
      })
    : null
  readonly collapseWriteOrder = ORCA_SIDEBAR_INPUTS_IS_MAIN ? new CollapseWriteOrder() : null
  readonly workspaceRows = ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? new WorkspaceRowsProducer({
        store: this.store,
        // Join metadata at read time so writes do not wait on Git scans.
        scan: () => this.scanResolvedWorktreeRepos(),
        join: (scans) => this.joinResolvedWorktreeScans(scans),
        visible: (snapshot) => this.visibleResolvedWorktreeSnapshot(snapshot),
        lifecycle: this.workspaceLifecycle,
        onClientEvent: (listener, options) => this.onClientEvent(listener, options)
      })
    : null
  readonly sidebarInputsFeed = ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? new SidebarInputsFeed(
        () =>
          sidebarInputsFeedDomains({
            facts: requireSwitchedOn(this.sidebarFacts),
            pairedServerRows: requireSwitchedOn(this.pairedServerRows),
            workspaceLifecycle: requireSwitchedOn(this.workspaceLifecycle),
            workspaceRows: requireSwitchedOn(this.workspaceRows),
            repoIcons: requireSwitchedOn(this.repoIconDataUrls),
            store: () => this.store,
            onClientEvent: (listener, options) => this.onClientEvent(listener, options)
          }),
        (event) => this.emitClientEvent(event)
      )
    : null

  private readonly references = new WorkspaceReferenceQueries({
    store: () => this.requireStore(),
    cachedWorktrees: () => this.resolvedWorktrees.peek()?.worktrees,
    scanWorktrees: () => this.listResolvedWorktrees(),
    resolveRepo: (selector) => this.resolveRepoSelector(selector),
    agents: async (workspaceKeys) =>
      createReferenceAgentIndex(
        this,
        this.getOrchestrationDbIfAvailable(),
        conversationRecordReader(await this.openAgentSessionRecordStore()),
        workspaceKeys,
        referenceConnectionHosts(this.listRepos())
      )
  })

  listWorkspaceReferences(selector: string, cwd?: string) {
    return this.references.list(selector, cwd)
  }

  findWorkspaceReferences(params: RuntimeReferenceFindParams) {
    return this.references.find(params)
  }

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithAgentTransitions>) {
    super(...args)
    // Headless hosts must register both invalidators themselves; they never load desktop IPC.
    registerDetectedWorktreeScanInvalidation()
    registerWorktreeChangeInvalidator((repoId) => this.invalidateWorktreeCatalog(repoId))
    registerWorktreeCatalogRoutes(this.store)
    publishWorkspaceViewChanges(this.store, (event) => this.emitClientEvent(event))
    publishBotSidebarViewChanges(this.store, () => this.notifyBotsChanged({ kinds: ['bot'] }))
    publishNativeChatPreferenceChanges(this.store, (event) => this.emitClientEvent(event))
    publishSettingsChanges(this.store, (event) => this.emitClientEvent(event))
    this.botSessions = botSessionHooks(this)
    this.botChatTreeIndex = runtimeBotChatTreeIndex(this)
    this.automation.botChat = botGroups.withGroupRoomChats(this, this.automation.botChat)
    syncPRAutoRefreshCadence(this.store)
  }

  /** What mobileRelay.hosts.list answers changed. */
  notifyRelayHostsChanged(): void {
    this.emitClientEvent({ type: 'relayHostsChanged' })
  }

  private structuredAgentAvailability?: ReturnType<typeof installAvailability>

  /** Subscribe from first use; returns the release function. */
  subscribeStructuredAgentAvailability(read: AvailabilityReader): () => void {
    this.structuredAgentAvailability ??= installAvailability(this.store, this)
    return this.structuredAgentAvailability.subscribe(read)
  }

  /** Whether a layout-owning window can show a tab before process creation. */
  canPublishAgentLaunchTab(): boolean {
    return Boolean(this.notifier?.publishAgentLaunchTab && this.hasAuthoritativeWindow())
  }

  /** Publish before spawn when a window owns the layout; otherwise return null. */
  publishAgentLaunchTab(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>
  ): Promise<AgentLaunchTabPublished> | null {
    if (!this.notifier?.publishAgentLaunchTab || !this.hasAuthoritativeWindow()) {
      return null
    }
    return this.notifier.publishAgentLaunchTab(request)
  }

  /** The window follows a listed active chat only on its own intent (#5435), so a focused launch names it. */
  focusLaunchedChatInHostWindow(worktreeId: string, sessionId: string): void {
    this.notifier?.focusEditorTab?.(structuredAgentSessionHostTabId(sessionId), worktreeId, {
      userInitiated: true
    })
  }

  /** Retain final verdicts, clear settled ones, and remove withdrawn panes without removing split siblings. */
  reportAgentLaunchPaneVerdict(
    pane: AgentLaunchPaneAddress,
    verdict: AgentLaunchPaneVerdict
  ): void {
    this.notifier?.agentLaunchPaneVerdict?.({ ...pane, verdict })
  }

  private readonly agentLaunchRecordWarmup = createAgentLaunchRecordWarmupGate({
    isOpen: () => peekOpenedAgentSessionRecordStore() !== null,
    open: () => this.openAgentSessionRecordStore()
  })

  /** Startup settled; opening still waits for a launch-capable client. */
  noteAgentLaunchStartupSettled(): void {
    this.agentLaunchRecordWarmup.startupSettled()
    // Retry only: watches are admitted by the host's serving milestone, which this timer can precede.
    this.startPullRequestWatches()
  }

  /** Warm up before the first client launch so that launch does not open the record. */
  noteAgentLaunchClientReady(): void {
    this.agentLaunchRecordWarmup.launchClientReady()
  }

  /** Plan a pane spawn through the host launch planner, including runtime attribution. */
  async planAgentPaneLaunch(
    worktreeId: string,
    opts: TerminalCreateOptions,
    sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  ): Promise<TerminalCreateOptions> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    return this.resolveAgentTerminalCreateOptions(workspace, opts, sessionOptions)
  }

  private readonly workspaceLayoutStream = new WorkspaceLayouts.WorkspaceLayoutStream({
    store: () => this.store,
    homeHostId: (key) => this.tryGetWorkspaceSessionHostIdForWorktree(key),
    liveTitle: (ptyId) => this.getTrackedDisplayTitleForPty(ptyId) || null,
    ...this.paneFactSources()
  })

  protected markPaneLiveTitlesDirty(ref: string): void {
    this.workspaceLayoutStream.markLiveTitlesDirty(ref)
  }

  protected continueRestoredWorkerMail(db: OrchestrationDb): void {
    continueRestoredWorkerMailSoon(this, db, () => this._orchestrationDb === db)
    botGroups.startBotGroupsSoon(this, () => this._orchestrationDb === db)
  }

  /** Read-only layout stream; layout.subscribe is not advertised yet. */
  subscribeWorkspaceLayouts(
    listener: Parameters<WorkspaceLayouts.WorkspaceLayoutStream['subscribe']>[0]
  ): ReturnType<WorkspaceLayouts.WorkspaceLayoutStream['subscribe']> {
    return this.workspaceLayoutStream.subscribe(listener)
  }

  /** Current main-owned layout projection, independent of window availability. */
  get workspaceLayoutReads(): WorkspaceLayouts.WorkspaceLayoutReads {
    return this.workspaceLayoutStream
  }

  /** Apply a window command to the partitions that hold its tab. */
  async applyLayoutCommand(
    command: Layout.WindowLayoutCommand,
    run?: Pick<Layout.LayoutCommandRunOptions, 'admit' | 'visibility'>
  ): Promise<LayoutApplyReply> {
    // Wait for live terminal placement before creating the first workspace surface.
    const placing = this.livePlacementSettledFor(command)
    const apply = (): Promise<LayoutApplyReply> =>
      Layout.applyWindowLayoutCommand(
        this.requireStore(),
        (worktreeId, tabId) =>
          tabId !== null
            ? this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId)
            : [this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId) ?? []].flat(),
        command,
        (move) => rekeyMovedPaneOwners(this, move),
        { ...this.layoutCommandRun(command), ...run }
      )
    // Order sleep/wake after previously accepted hook statuses.
    const reply = await (ORCA_LAYOUT_OWNER_IS_MAIN && ['sleep', 'wake'].includes(command.type)
      ? this.inResumeRecordOrder(apply)
      : (placing?.then(apply) ?? apply()))
    // The frame precedes the reply so the window can wait for its visible change.
    return { ...reply, frameSeq: this.workspaceLayoutStream.settledSeq() }
  }

  /** Display-only copies of paired-server layouts. */
  getRemoteLayoutSnapshots(): Record<string, RemoteLayoutSnapshot> {
    return this.store?.getRemoteLayoutSnapshots?.() ?? {}
  }

  /** Return the already-open record store without waiting. */
  openedAgentSessionRecordStore(): AgentSessionRecordStore | null {
    return peekOpenedAgentSessionRecordStore()
  }
}
// Linear installs these methods on the final runtime prototype below.
// oxlint-disable-next-line typescript/consistent-type-definitions -- SAFETY: This merge models the installed Linear API.
interface OrcaRuntimeService extends RuntimeLinearCommandSurface {}

type OrcaRuntimeServiceExport = RuntimeCommandSurfaceHost<OrcaRuntimeService>
const OrcaRuntimeServiceExport: {
  new (...args: ConstructorParameters<typeof OrcaRuntimeService>): OrcaRuntimeServiceExport
  readonly prototype: OrcaRuntimeServiceExport
} = OrcaRuntimeService
export { OrcaRuntimeServiceExport as OrcaRuntimeService }
installRuntimeLinearCommandSurface(OrcaRuntimeServiceExport.prototype)
