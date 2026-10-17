import type { RuntimeLinearCommandSurface } from './runtime-linear-command-surface'
import { installRuntimeLinearCommandSurface } from './runtime-linear-command-surface'
import { publishWorkspaceViewChanges } from './runtime-workspace-view-change-events'
import { OrcaRuntimeWithWorkspaceActivityFacts } from './sidebar-inputs/orca-runtime-workspace-activity-facts'
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
import { WorkspaceLayoutStream } from './workspace-layout-stream'
import type { RemoteLayoutSnapshot } from '../../shared/remote-layout-snapshot'
import { registerDetectedWorktreeScanInvalidation } from '../ipc/worktrees/listing/register-detected-worktree-scan-invalidation'
import {
  listReferenceWorkspaces,
  selectReferenceWorkspace,
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
  type StructuredAgentAvailability,
  type StructuredAgentAvailabilityReader
} from './structured-agent-availability'
import { resolveHostStructuredAgentCreateSupport } from './structured-agent-launch-support'
import { PairedServerRowsProducer } from './sidebar-inputs/paired-server-rows-producer'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { getHostDisplayLabelOverrides } from '../../shared/host-setting-overrides'

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- SAFETY: The existing Linear installer supplies the canonical prototype surface.
class OrcaRuntimeService extends OrcaRuntimeWithWorkspaceActivityFacts {
  // Idle until relay hosts attach. The fallback refresh runs while a window shows the sidebar.
  readonly pairedServerRows = new PairedServerRowsProducer({
    hasDemand: () =>
      this.authoritativeWindowId !== null &&
      this.authoritativeWindowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.store?.getUI?.().sidebarOpen !== false,
    hostLabelOverrides: () => getHostDisplayLabelOverrides(this.getClientSettings())
  })

  private async selectReferenceCatalogWorkspace(selector: string, cwd?: string) {
    const catalog = listReferenceWorkspaces(
      this.requireStore(),
      this.resolvedWorktrees.peek()?.worktrees
    )
    try {
      return selectReferenceWorkspace(catalog, selector, cwd)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'selector_not_found') {
        throw error
      }
      // Why: unsaved worktrees and cold-cache branches only resolve after a worktree scan.
      const warmed = listReferenceWorkspaces(
        this.requireStore(),
        await this.listResolvedWorktrees()
      )
      return selectReferenceWorkspace(warmed, selector, cwd)
    }
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
          await this.openAgentSessionRecordStore(),
          workspaceKeys,
          referenceConnectionHosts(this.listRepos())
        )
    })
  }

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithWorkspaceActivityFacts>) {
    super(...args)
    // Why: the runtime listing re-runs a scan the worktree-change generation overtook and re-lists
    // through this runtime's scan cache, so a worktree change must reach both. The desktop IPC
    // module registers the generation bump at load; a headless host never loads it.
    registerDetectedWorktreeScanInvalidation()
    registerWorktreeChangeInvalidator((repoId) => this.invalidateWorktreeCatalog(repoId))
    publishWorkspaceViewChanges(this.store, (event) => this.emitClientEvent(event))
  }

  private structuredAgentAvailability: StructuredAgentAvailability | undefined

  /** Every registered agent's createSupport answer in this workspace, shared by all its readers and
   *  published as complete generations; returns the release. */
  subscribeStructuredAgentAvailability(
    worktreeSelector: string,
    read: StructuredAgentAvailabilityReader
  ): () => void {
    this.structuredAgentAvailability ??= installStructuredAgentAvailability(
      this.store,
      async (worktree, agent) =>
        resolveHostStructuredAgentCreateSupport({
          agent,
          worktreeSelector: worktree,
          location: await this.resolveStructuredAgentSessionLocation(worktree),
          runtime: this,
          refreshShellOnMiss: false
        })
    )
    return this.structuredAgentAvailability.subscribe(worktreeSelector, read)
  }

  protected override notifyReposChanged(): void {
    super.notifyReposChanged()
    // Why Windows only: a project's WSL runtime choice is the repo setting a chat's location reads.
    if (process.platform === 'win32') {
      this.structuredAgentAvailability?.rederive()
    }
  }

  /** Whether a window owns the layout and can show a launch's tab ahead of its process. */
  canPublishAgentLaunchTab(): boolean {
    return Boolean(this.notifier?.publishAgentLaunchTab && this.getAvailableAuthoritativeWindow())
  }

  /** Shows an agent launch's tab before its process exists, in the window that owns the layout;
   *  null when no window does, and the launch's tab then appears when it spawns, as before. */
  publishAgentLaunchTab(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>
  ): Promise<AgentLaunchTabPublished> | null {
    if (!this.notifier?.publishAgentLaunchTab || !this.getAvailableAuthoritativeWindow()) {
      return null
    }
    return this.notifier.publishAgentLaunchTab(request)
  }

  /** Tells the window a launch pane's fate: it keeps a final one on the tab, clears a settled one,
   *  and takes a withdrawn pane back (the pane alone when the user split the tab). */
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

  /** Startup is done; the launch record may open once a client that can launch is here too. */
  noteAgentLaunchStartupSettled(): void {
    this.agentLaunchRecordWarmup.startupSettled()
  }

  /** A client that can call `agent.launch` connected; its first launch should not open the record. */
  noteAgentLaunchClientReady(): void {
    this.agentLaunchRecordWarmup.launchClientReady()
  }

  /** Plans an agent launch a window pane's own spawn asks for, with the planner every host launch
   *  uses, including its runtime fact. */
  async planAgentPaneLaunch(
    worktreeId: string,
    opts: TerminalCreateOptions
  ): Promise<TerminalCreateOptions> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    return this.resolveAgentTerminalCreateOptions(workspace, opts)
  }

  /** Whether a running process holds this pane now: such a pane is attached to, never launched into. */
  hasLiveTerminalForPaneKey(paneKey: string): boolean {
    return this.getPtyRecordForPaneKey(paneKey)?.connected === true
  }

  private readonly workspaceLayoutStream = new WorkspaceLayoutStream({
    store: () => this.store,
    homeHostId: (key) => this.tryGetWorkspaceSessionHostIdForWorktree(key),
    // An empty title is no title.
    liveTitle: (ptyId) => this.getTrackedDisplayTitleForPty(ptyId) || null
  })

  protected markPaneLiveTitlesDirty(): void {
    this.workspaceLayoutStream.markLiveTitlesDirty()
  }

  /** The read-only layout stream (`layout.subscribe`, not advertised yet). */
  subscribeWorkspaceLayouts(
    listener: Parameters<WorkspaceLayoutStream['subscribe']>[0]
  ): ReturnType<WorkspaceLayoutStream['subscribe']> {
    return this.workspaceLayoutStream.subscribe(listener)
  }

  /** A window's layout command (`layout.apply`), applied to the partitions that hold its tab. */
  async applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply> {
    const reply = await applyWindowLayoutCommand(
      this.requireStore(),
      (worktreeId, tabId) => {
        if (tabId !== null) {
          return this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId)
        }
        const routed = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
        return routed ? [routed] : []
      },
      command,
      (move) => rekeyMovedPaneOwners(this, move)
    )
    // Sent before the reply, so the window can wait for the frame that shows the change.
    return { ...reply, frameSeq: this.workspaceLayoutStream.settledSeq() }
  }

  /** This desktop's display-only copy of each paired server's layout (`layout.getRemoteSnapshots`). */
  getRemoteLayoutSnapshots(): Record<string, RemoteLayoutSnapshot> {
    return this.store?.getRemoteLayoutSnapshots?.() ?? {}
  }

  /** The launch record when it is already open, for a reader that must not wait for it. */
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
