import type { SessionOptionValue } from '../../shared/native-chat/input/native-chat-session-options'
import { conversationRecordReader } from './orchestration/addressing/session-lineage/structured-session-lineage'
import type { RuntimeLinearCommandSurface } from './integrations/linear/runtime-linear-command-surface'
import { installRuntimeLinearCommandSurface } from './integrations/linear/runtime-linear-command-surface'
import { publishNativeChatPreferenceChanges } from './agent-session/launch/runtime-native-chat-preference-events'
import { publishSettingsChanges } from './client/settings/runtime-settings-change-events'
import { publishWorkspaceViewChanges } from './sidebar-inputs/runtime-workspace-view-change-events'
import {
  OrcaRuntimeWithSidebarTemporal,
  sidebarFactsRuntime
} from './sidebar-inputs/orca-runtime-sidebar-temporal'
import { OrcaRuntimeWithAgentTransitions } from './construction/orca-runtime-agent-transitions'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
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
import type { RemoteLayoutSnapshot } from '../../shared/remote-layout-snapshot'
import { registerDetectedWorktreeScanInvalidation } from '../ipc/worktrees/listing/register-detected-worktree-scan-invalidation'
import {
  listReferenceWorkspaces,
  selectWarmedReferenceWorkspace,
  listWorkspaceReferences
} from './workspaces/references/runtime-reference-catalog'
import { findWorkspaceReferences } from './workspaces/references/runtime-reference-find'
import {
  createReferenceAgentIndex,
  referenceConnectionHosts
} from './workspaces/references/runtime-reference-agents'
import type { RuntimeReferenceFindParams } from '../../shared/runtime-reference-contracts'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyReply } from '../../shared/workspace-layout/workspace-layout-command-types'
import { rekeyMovedPaneOwners } from './terminal/identity/moved-pane-owner-rekey'
import * as Layout from './terminal/layout/runtime-layout-apply'
import type { TerminalCreateOptions } from './terminal/launch/terminal-create-options'
import {
  installStructuredAgentAvailability as installAvailability,
  type StructuredAgentAvailabilityReader as AvailabilityReader
} from './agent-session/launch/structured-agent-availability'
import { PairedServerRowsProducer } from './sidebar-inputs/paired-server-rows-producer'
import { RepoIconDataUrls } from './sidebar-inputs/repo-icon-data-urls'
import { WorkspaceRowsProducer } from './sidebar-inputs/workspace-rows-producer'
import { getMainHttpClient } from '../network/http-client'
import { getRuntimeDesktopSurface } from './construction/runtime-desktop-surface'
import { CollapseWriteOrder } from './sidebar-inputs/workspace-view-collapse-writes'
import { SidebarInputsFeed } from './sidebar-inputs/sidebar-inputs-feed'
import { sidebarInputsFeedDomains } from './sidebar-inputs/sidebar-inputs-feed-domains'
import { requireSwitchedOn } from './sidebar-inputs/require-switched-on'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { getHostDisplayLabelOverrides } from '../../shared/host-setting-overrides'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import { continueRestoredWorkerMailSoon } from './rpc/methods/orchestration/messaging/settled-worker-follow-through'
import {
  PeerMailRelay,
  type PeerServerAnswerStatus
} from './orchestration/federation/peer-mail/peer-mail-relay'
import { structuredAgentSessionHostTabId } from '../../shared/agent-session/view/structured-agent-session-host-tab-id'

const OrcaRuntimeSidebarBase: typeof OrcaRuntimeWithAgentTransitions = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? OrcaRuntimeWithSidebarTemporal
  : OrcaRuntimeWithAgentTransitions

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- SAFETY: The existing Linear installer supplies the canonical prototype surface.
class OrcaRuntimeService extends OrcaRuntimeSidebarBase {
  // Lazy: the database can open, and arm relays, while the runtime is still constructing.
  declare private peerMailRelay: PeerMailRelay | undefined

  override ensureOrchestrationFederationRelay(
    runId?: string,
    options?: { keepAwake?: boolean }
  ): void {
    super.ensureOrchestrationFederationRelay(runId, options)
    this.peerMailRelay ??= new PeerMailRelay(this, () => this.orchestrationEnvironmentTransport)
    this.peerMailRelay.ensure()
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
        // The desktop net.fetch wrapper rejects manual redirects.
        fetch: (url, init) => {
          const manualRedirectFetch = getRuntimeDesktopSurface().fetchRepoIcon
          return manualRedirectFetch
            ? manualRedirectFetch(url, init)
            : getMainHttpClient().fetch(url, init)
        },
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

  private selectReferenceCatalogWorkspace(selector: string, cwd?: string) {
    return selectWarmedReferenceWorkspace(
      this.requireStore(),
      {
        cached: () => this.resolvedWorktrees.peek()?.worktrees,
        scan: () => this.listResolvedWorktrees()
      },
      selector,
      cwd
    )
  }

  async listWorkspaceReferences(selector: string, cwd?: string) {
    return listWorkspaceReferences(await this.selectReferenceCatalogWorkspace(selector, cwd))
  }

  async findWorkspaceReferences(params: RuntimeReferenceFindParams) {
    if (params.worktree && params.repo) {
      throw new Error('--repo and --worktree cannot be combined')
    }
    let workspaces = params.worktree
      ? [await this.selectReferenceCatalogWorkspace(params.worktree, params.cwd)]
      : listReferenceWorkspaces(this.requireStore(), this.resolvedWorktrees.peek()?.worktrees)
    if (params.repo) {
      const repo = await this.resolveRepoSelector(params.repo)
      workspaces = workspaces.filter(
        (row) =>
          row.kind === 'worktree' &&
          row.repoId === repo.id &&
          row.hostId === getRepoExecutionHostId(repo)
      )
    }
    return findWorkspaceReferences(params, {
      workspaces,
      agents: async (workspaceKeys) =>
        createReferenceAgentIndex(
          this,
          this.getOrchestrationDbIfAvailable(),
          conversationRecordReader(await this.openAgentSessionRecordStore()),
          workspaceKeys,
          referenceConnectionHosts(this.listRepos())
        )
    })
  }

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithAgentTransitions>) {
    super(...args)
    // Headless hosts must register both invalidators themselves; they never load desktop IPC.
    registerDetectedWorktreeScanInvalidation()
    registerWorktreeChangeInvalidator((repoId) => this.invalidateWorktreeCatalog(repoId))
    publishWorkspaceViewChanges(this.store, (event) => this.emitClientEvent(event))
    publishNativeChatPreferenceChanges(this.store, (event) => this.emitClientEvent(event))
    publishSettingsChanges(this.store, (event) => this.emitClientEvent(event))
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
    return Boolean(this.notifier?.publishAgentLaunchTab && this.getAvailableAuthoritativeWindow())
  }

  /** Publish before spawn when a window owns the layout; otherwise return null. */
  publishAgentLaunchTab(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>
  ): Promise<AgentLaunchTabPublished> | null {
    if (!this.notifier?.publishAgentLaunchTab || !this.getAvailableAuthoritativeWindow()) {
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
    // Desktop and serve: CI-line watches start here, past first paint, chat or no chat.
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

  protected markPaneLiveTitlesDirty(): void {
    this.workspaceLayoutStream.markLiveTitlesDirty()
  }

  protected continueRestoredWorkerMail(db: OrchestrationDb): void {
    continueRestoredWorkerMailSoon(this, db, () => this._orchestrationDb === db)
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
