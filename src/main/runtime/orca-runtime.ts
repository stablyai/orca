import { installRuntimeLinearCommandSurface } from './runtime-linear-command-surface'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
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
import {
  shouldWatchLayoutRoundTrip,
  watchLayoutRoundTrip
} from './workspace-layout-round-trip-watch'
import { registerDetectedWorktreeScanInvalidation } from '../ipc/worktrees/listing/register-detected-worktree-scan-invalidation'

class OrcaRuntimeService extends OrcaRuntimeWithMigrationCatalog {
  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithMigrationCatalog>) {
    super(...args)
    // Why: the runtime listing re-runs a scan the worktree-change generation overtook and re-lists
    // through this runtime's scan cache, so a worktree change must reach both. The desktop IPC
    // module registers the generation bump at load; a headless host never loads it.
    registerDetectedWorktreeScanInvalidation()
    registerWorktreeChangeInvalidator((repoId) => this.invalidateWorktreeCatalog(repoId))
    if (this.store && shouldWatchLayoutRoundTrip()) {
      watchLayoutRoundTrip(this.store)
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

  /** Whether a running process holds this pane now: such a pane is attached to, never launched into. */
  hasLiveTerminalForPaneKey(paneKey: string): boolean {
    return this.getPtyRecordForPaneKey(paneKey)?.connected === true
  }

  private readonly workspaceLayoutStream = new WorkspaceLayoutStream({
    store: () => this.store,
    homeHostId: (key) => this.tryGetWorkspaceSessionHostIdForWorktree(key)
  })

  /** The read-only layout stream (`layout.subscribe`, not advertised yet). */
  subscribeWorkspaceLayouts(
    listener: Parameters<WorkspaceLayoutStream['subscribe']>[0]
  ): ReturnType<WorkspaceLayoutStream['subscribe']> {
    return this.workspaceLayoutStream.subscribe(listener)
  }

  /** The launch record when it is already open, for a reader that must not wait for it. */
  openedAgentSessionRecordStore(): AgentSessionRecordStore | null {
    return peekOpenedAgentSessionRecordStore()
  }
}
type OrcaRuntimeServiceExport = RuntimeCommandSurfaceHost<OrcaRuntimeService>
const OrcaRuntimeServiceExport = OrcaRuntimeService as unknown as {
  new (...args: ConstructorParameters<typeof OrcaRuntimeService>): OrcaRuntimeServiceExport
  readonly prototype: OrcaRuntimeServiceExport
}
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
  RuntimePtyDataAdmission,
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
