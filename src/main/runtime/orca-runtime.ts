import { conversationRecordReader } from './orchestration/structured-session-lineage'
import type { RuntimeLinearCommandSurface } from './runtime-linear-command-surface'
import { installRuntimeLinearCommandSurface } from './runtime-linear-command-surface'
import { publishNativeChatFollowUpChanges } from './runtime-native-chat-follow-up-events'
import { publishWorkspaceViewChanges } from './runtime-workspace-view-change-events'
import {
  OrcaRuntimeWithSidebarTemporal,
  sidebarFactsRuntime
} from './sidebar-inputs/orca-runtime-sidebar-temporal'
import { OrcaRuntimeWithAgentTransitions } from './orca-runtime-agent-transitions'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch-tab-publication'
import type {
  AgentLaunchPaneAddress,
  AgentLaunchPaneVerdict
} from '../../shared/agent-launch-pane-verdict'
import { registerWorktreeChangeInvalidator } from '../ipc/worktree-change-invalidators'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { peekOpenedAgentSessionRecordStore } from './agent-session-record-store-slot'
import { createAgentLaunchRecordWarmupGate } from './agent-launch-record-warmup-gate'
import { WorkspaceLayoutStream, type WorkspaceLayoutReads } from './workspace-layout-stream'
import type { RemoteLayoutSnapshot } from '../../shared/remote-layout-snapshot'
import { registerDetectedWorktreeScanInvalidation } from '../ipc/worktrees/listing/register-detected-worktree-scan-invalidation'
import {
  listReferenceWorkspaces,
  selectWarmedReferenceWorkspace,
  listWorkspaceReferences
} from './runtime-reference-catalog'
import { findWorkspaceReferences } from './runtime-reference-find'
import { createReferenceAgentIndex, referenceConnectionHosts } from './runtime-reference-agents'
import type { RuntimeReferenceFindParams } from '../../shared/runtime-reference-contracts'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyReply } from '../../shared/workspace-layout/workspace-layout-command-types'
import { rekeyMovedPaneOwners } from './moved-pane-owner-rekey'
import { applyWindowLayoutCommand, type WindowLayoutCommand } from './runtime-layout-apply'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import {
  installStructuredAgentAvailability,
  type StructuredAgentAvailabilityReader
} from './structured-agent-availability'
import { PairedServerRowsProducer } from './sidebar-inputs/paired-server-rows-producer'
import { RepoIconDataUrls } from './sidebar-inputs/repo-icon-data-urls'
import { WorkspaceRowsProducer } from './sidebar-inputs/workspace-rows-producer'
import { getMainHttpClient } from '../network/http-client'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import { CollapseWriteOrder } from './workspace-view-collapse-writes'
import { SidebarInputsFeed } from './sidebar-inputs/sidebar-inputs-feed'
import { sidebarInputsFeedDomains } from './sidebar-inputs/sidebar-inputs-feed-domains'
import { requireSwitchedOn } from './sidebar-inputs/require-switched-on'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { getHostDisplayLabelOverrides } from '../../shared/host-setting-overrides'
import type { OrchestrationDb } from './orchestration/db'
import { continueRestoredWorkerMailSoon } from './rpc/methods/orchestration/messaging/settled-worker-follow-through'

const OrcaRuntimeSidebarBase: typeof OrcaRuntimeWithAgentTransitions = ORCA_SIDEBAR_INPUTS_IS_MAIN
  ? OrcaRuntimeWithSidebarTemporal
  : OrcaRuntimeWithAgentTransitions

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- SAFETY: The existing Linear installer supplies the canonical prototype surface.
class OrcaRuntimeService extends OrcaRuntimeSidebarBase {
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
    publishNativeChatFollowUpChanges(this.store, (event) => this.emitClientEvent(event))
  }

  private structuredAgentAvailability?: ReturnType<typeof installStructuredAgentAvailability>

  /** Subscribe from first use; returns the release function. */
  subscribeStructuredAgentAvailability(read: StructuredAgentAvailabilityReader): () => void {
    this.structuredAgentAvailability ??= installStructuredAgentAvailability(this.store, this)
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
  }

  /** Warm up before the first client launch so that launch does not open the record. */
  noteAgentLaunchClientReady(): void {
    this.agentLaunchRecordWarmup.launchClientReady()
  }

  /** Plan a pane spawn through the host launch planner, including runtime attribution. */
  async planAgentPaneLaunch(
    worktreeId: string,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    return this.resolveAgentTerminalCreateOptions(workspace, opts)
  }

  private readonly workspaceLayoutStream = new WorkspaceLayoutStream({
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
    listener: Parameters<WorkspaceLayoutStream['subscribe']>[0]
  ): ReturnType<WorkspaceLayoutStream['subscribe']> {
    return this.workspaceLayoutStream.subscribe(listener)
  }

  /** Current main-owned layout projection, independent of window availability. */
  get workspaceLayoutReads(): WorkspaceLayoutReads {
    return this.workspaceLayoutStream
  }

  /** Apply a window command to the partitions that hold its tab. */
  async applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply> {
    // Wait for live terminal placement before creating the first workspace surface.
    const placing = this.livePlacementSettledFor(command)
    const apply = (): Promise<LayoutApplyReply> =>
      applyWindowLayoutCommand(
        this.requireStore(),
        (worktreeId, tabId) =>
          tabId !== null
            ? this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId)
            : [this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId) ?? []].flat(),
        command,
        (move) => rekeyMovedPaneOwners(this, move),
        this.layoutCommandRun(command)
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

export type { LegacyWorkerTerminalRecoveryResult } from './runtime-legacy-worker-terminal-recovery-types'
export type {
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput
} from './runtime-automation-controller'
export type { SubscriptionRegistration } from './runtime-subscription-registry'
export type {
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilityTerminalAuthority,
  RuntimeTerminalAgentStatusEvent
} from './runtime-terminal-contracts'
export type { MessageWaitResult } from './runtime-message-waiters'
export type { AccountsSnapshot, CodexRateLimitResetRpcResult } from './runtime-account-controller'
export type {
  MobileNotificationDispatchEvent,
  MobileNotificationDismissEvent,
  MobileNotificationEvent
} from './runtime-mobile-notification-controller'
export type { RuntimeTerminalDataMeta } from './runtime-terminal-stream-consumers'
export type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
export {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason,
  type TerminalTailWaitState
} from './terminal-wait-tail-state'
export { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
export { appendNormalizedToMultilineTailBufferUnwindowed } from './terminal-tail-redraw-buffer'
export { buildPreview } from './terminal-tail-state'
export { buildRestoredTerminalTailSeed } from './terminal-tail-restore-seed'
export { projectTerminalTailLines } from './orca-runtime-terminal-projection'
export { resolveWorktreeScanCacheTtlMs } from './runtime-worktree-scan-cache'
export type {
  RuntimeWorktreeLifecycleEvent,
  DriverState,
  PtyLayoutTarget,
  PtyLayoutState,
  ApplyLayoutResult,
  RuntimeRendererReloadFence
} from './orca-runtime-core'
export {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS,
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS
} from './orca-runtime-postlude'
