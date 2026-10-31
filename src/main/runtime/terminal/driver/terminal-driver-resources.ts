import type { RuntimeServiceCommandSurface } from '../../runtime-service-command-surface'
import {
  remoteCliBrowserScopeWorkspaceId,
  resolveRemoteCliBrowserScopeSelector
} from '../../desktop-browser-bridge/remote-cli-browser-scope'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { RuntimeAccountController } from '../../runtime-account-controller'
import type { BrowserNetworkExecutionHost } from '../../../../shared/browser-network-execution-host'
import type { BrowserWindow } from 'electron'
import type { BrowserSessionTabSelectionOptions } from '../../browser-tab-create-publication'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type {
  RuntimeTerminalClose,
  RuntimeTerminalRead
} from '../../../../shared/runtime-terminal-contracts'
import type { ExactWorkerProviderSession } from '../../../../shared/orchestration-worker-output'
import type { RuntimeProviderSnapshotReadOptions } from '../../runtime-terminal-contracts'
import { OrcaRuntimeWithFitOverrideListeners } from '../lifecycle/terminal-view-resources'
import type {
  DriverState,
  ApplyLayoutResult,
  PtyLayoutTarget,
  LayoutQueueEntry,
  PtyLayoutState
} from '../../orca-runtime-core'

import { RuntimeTerminalDriverController } from '../../runtime-terminal-driver-controller'
import { RuntimeEdgeCommandController } from '../../runtime-edge-command-controller'
import { getBrowserHostLeaseRegistry } from '../../browser-host/browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'

import { RuntimeBrowserDriverController } from '../../runtime-browser-driver-controller'
import { RemoteDesktopTerminalFloor } from '../../remote-desktop-terminal-floor'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import type { StatsCollector } from '../../../stats/collector'
import { RuntimeRemoteFetchController } from '../../runtime-remote-fetch-controller'
import { RuntimeWorktreeBaseReconciliation } from '../../runtime-worktree-base-reconciliation'
import { RuntimeWorktreeRemovalInFlight } from '../../runtime-worktree-removal-in-flight'
import { ServeBrowserTabs } from '../../serve-browser-tabs'
import { readBrowserTabBar } from '../../browser/browser-tab-listing'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { ServeBrowserPageState } from '../../serve-browser-tab-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'

export abstract class OrcaRuntimeWithTerminalDrivers extends OrcaRuntimeWithFitOverrideListeners {
  declare registerSubscriptionCleanup: RuntimeServiceCommandSurface['registerSubscriptionCleanup']
  declare cleanupSubscription: RuntimeServiceCommandSurface['cleanupSubscription']

  protected abstract resolveBrowserWorkspace(selector: string): Promise<ResolvedWorktree>
  protected abstract resolveBrowserNetworkExecutionHostForWorktree(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost>
  abstract getAuthoritativeWindow(missingWindowMessage?: string): BrowserWindow
  protected abstract getAvailableAuthoritativeWindow(): BrowserWindow | null
  protected abstract markHeadlessBrowserSessionTabActive(
    worktreeId: string | undefined,
    browserPageId: string,
    options: BrowserSessionTabSelectionOptions
  ): void
  abstract notifyMobileSessionTabsChanged(worktreeId?: string): void
  protected abstract getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId
  protected abstract setWorkspaceSessionForWorktree(
    worktreeId: string,
    session: WorkspaceSessionState
  ): void
  declare protected readonly accounts: RuntimeAccountController
  abstract retireRuntimeOwnedBrowserSessionTab(worktreeId: string, browserPageId: string): boolean
  protected abstract resolveEmulatorWorkspaceId(selector: string): Promise<string>
  protected abstract resolveEmulatorCleanupWorkspaceId(selector: string): Promise<string>
  abstract requireStore(): RuntimeStore
  abstract getRuntimeId(): string
  abstract hasRawTerminalViewSubscriber(ptyId: string): boolean
  abstract resolveTerminalHandleByProcessIncarnation(
    processIncarnation: string,
    serializedHostScope: string | null
  ): string | null
  abstract getTerminalLivenessVerdict(handle: string): PtyLivenessVerdict | null
  abstract checkTerminalAgentPresence(
    handle: string,
    exitedSince: number
  ): Promise<'live' | 'unverifiable' | 'exited' | null>
  abstract ensureStructuredAgentSessionHost(): Promise<void>
  abstract inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null
  ): Promise<'live' | 'exited' | 'unverifiable'>
  abstract closeTerminal(handle: string): Promise<RuntimeTerminalClose>
  abstract getExactWorkerProviderSession(
    handle: string,
    observedAfter: number
  ): ExactWorkerProviderSession | null
  abstract readTerminal(
    handle: string,
    opts?: {
      cursor?: number
      limit?: number
      screen?: boolean
    },
    providerSnapshot?: RuntimeProviderSnapshotReadOptions
  ): Promise<RuntimeTerminalRead>

  abstract getDriver(ptyId: string): DriverState
  protected abstract enqueueLayout(
    ptyId: string,
    target: PtyLayoutTarget
  ): Promise<ApplyLayoutResult>
  abstract mobileTookFloor(
    ptyId: string,
    clientId: string,
    previousFloor?: DriverState,
    isCurrent?: () => boolean
  ): Promise<void>
  protected abstract resolveDesktopRestoreTarget(ptyId: string): { cols: number; rows: number }
  abstract getTerminalSize(ptyId: string): { cols: number; rows: number } | null

  // Mobile ownership locks desktop input/resize in both renderer and main; clientId selects the active phone viewport (docs/mobile-presence-lock.md).
  protected readonly terminalDrivers = new RuntimeTerminalDriverController({
    notifyChanged: (ptyId, next) => this.notifier?.terminalDriverChanged(ptyId, next),
    canClaimMobileFloor: (ptyId, clientId) => {
      const softLeaver = this.pendingSoftLeavers.get(ptyId)
      return this.mobileSubscribers.get(ptyId)?.has(clientId) || softLeaver?.clientId === clientId
    },
    commitMobileFloor: (ptyId, clientId, previousFloor, isCurrent) =>
      this.mobileTookFloor(ptyId, clientId, previousFloor, isCurrent)
  })

  protected readonly serveBrowserTabs = new ServeBrowserTabs({
    backend: () => (this.getAvailableAuthoritativeWindow() ? null : this.offscreenBrowserBackend),
    livePageIds: (worktreeId) =>
      new Set(
        (this.agentBrowserBridge?.tabList?.(worktreeId).tabs ?? []).map((tab) => tab.browserPageId)
      ),
    savedWorktreeIds: () =>
      (this.store?.getWorkspaceSessionHostIds?.() ?? []).flatMap((hostId) =>
        Object.keys(this.store?.getWorkspaceSession?.(hostId)?.browserTabsByWorktree ?? {})
      ),
    session: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
    hostId: (worktreeId) => this.getWorkspaceSessionHostIdForWorktree(worktreeId),
    save: (worktreeId, session) => this.setWorkspaceSessionForWorktree(worktreeId, session),
    // Switch point: a layout-owner build writes served tabs through `layout.apply`.
    ...(ORCA_LAYOUT_OWNER_IS_MAIN
      ? {
          applyLayout: async (command: LayoutCommand, hostId: ExecutionHostId) => {
            const store = this.requireStore()
            if (!store.applyLayoutCommand) {
              throw new Error('layout_store_unavailable')
            }
            return store.applyLayoutCommand(command, [hostId])
          }
        }
      : {})
  })

  serveBrowserPageNavigated(page: ServeBrowserPageState): void {
    this.serveBrowserTabs.navigated(page)
  }

  protected readonly edgeCommands = new RuntimeEdgeCommandController({
    jiraHost: {
      getSettings: () => this.requireStore().getSettings(),
      getAgentEnvironment: () => this.accounts.getCommitMessageAgentEnvironment()
    },
    browserHost: {
      getRuntimeId: () => this.getRuntimeId(),
      getAgentBrowserBridge: () => this.agentBrowserBridge,
      resolveWorkspaceSelector: (selector) =>
        resolveRemoteCliBrowserScopeSelector(selector) ?? this.resolveWorkspaceSelector(selector),
      resolveBrowserWorkspace: (selector) =>
        resolveRemoteCliBrowserScopeSelector(selector) ?? this.resolveBrowserWorkspace(selector),
      getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(this),
      getRuntimeBrowserPageRegistry: () => getRuntimeBrowserPageRegistry(this),
      resolveBrowserNetworkExecutionHost: (worktree) =>
        this.resolveBrowserNetworkExecutionHostForWorktree(worktree),
      getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
      getAvailableAuthoritativeWindow: () => this.getAvailableAuthoritativeWindow(),
      getOffscreenBrowserBackend: () => this.offscreenBrowserBackend,
      markHeadlessBrowserSessionTabActive: this.markHeadlessBrowserSessionTabActive.bind(this),
      notifyHeadlessBrowserSessionTabsChanged: (worktreeId) =>
        this.notifyMobileSessionTabsChanged(worktreeId),
      readBrowserTabBar: (worktreeId) =>
        readBrowserTabBar(this.mobileSessionTabsByWorktree, worktreeId, (id) => {
          // Why: an SSH host's bridged workspace may have no row here, yet its pages render in this window.
          if (id === remoteCliBrowserScopeWorkspaceId()) {
            return true
          }
          const scope = parseWorkspaceKey(id)
          return scope?.type === 'folder'
            ? (this.store?.getFolderWorkspaces?.() ?? []).some(
                (workspace) => workspace.id === scope.folderWorkspaceId
              )
            : (this.store?.getRepos() ?? []).some((repo) => repo.id === getRepoIdFromWorktreeId(id))
        }),
      retireRuntimeOwnedBrowserSessionTab: (worktreeId, browserPageId) =>
        this.retireRuntimeOwnedBrowserSessionTab(worktreeId, browserPageId),
      serveBrowserTabs: this.serveBrowserTabs
    },
    screencast: {
      registerSubscriptionCleanup: (subscriptionId, cleanup, connectionId) =>
        this.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId),
      cleanupSubscription: (subscriptionId) => this.cleanupSubscription(subscriptionId),
      getDriver: (browserPageId) => this.browserDrivers.get(browserPageId),
      setDriver: (browserPageId, next) => this.browserDrivers.set(browserPageId, next),
      notifyRemoteViewersChanged: (browserPageId, hasRemoteViewers) =>
        this.notifier?.browserRemoteViewersChanged?.(browserPageId, hasRemoteViewers)
    },
    getBrowserCommands: () => this.browserCommands,
    emulatorHost: {
      getEmulatorBridge: () => this.emulatorBridge,
      resolveEmulatorWorkspaceId: (selector) => this.resolveEmulatorWorkspaceId(selector),
      resolveEmulatorCleanupWorkspaceId: (selector) =>
        this.resolveEmulatorCleanupWorkspaceId(selector),
      getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
      getSettings: () => this.requireStore().getSettings()
    }
  })

  // Tests and diagnostics replace screencast startup; other edge methods stay pre-bound.
  protected browserCommands = this.edgeCommands.getBrowserCommands()

  protected readonly browserDrivers = new RuntimeBrowserDriverController({
    notifyChanged: (browserPageId, next) =>
      this.notifier?.browserDriverChanged?.(browserPageId, next),
    cancelScreencast: (browserPageId) => this.edgeCommands.cancelScreencast(browserPageId)
  })

  protected readonly remoteDesktopFloor = new RemoteDesktopTerminalFloor({
    isMobileDriven: (ptyId) => this.getDriver(ptyId).kind === 'mobile',
    getTerminalSize: (ptyId) => this.getTerminalSize(ptyId) ?? null,
    resolveHostTarget: (ptyId) => this.resolveDesktopRestoreTarget(ptyId),
    hostShowsTerminals: () => this.authoritativeWindowId !== HEADLESS_RUNTIME_WINDOW_ID,
    applyLayout: async (ptyId, target) => {
      this.freshSubscribeGuard.add(ptyId)
      try {
        return await this.enqueueLayout(ptyId, target)
      } finally {
        this.freshSubscribeGuard.delete(ptyId)
      }
    }
  })

  // Keep the leaving client snapshot by PTY for ~250ms so reconnects/older clients avoid banner flashes and capturing phone-fit restore baselines (docs/mobile-presence-lock.md).
  protected pendingSoftLeavers = new Map<
    string,
    {
      clientId: string
      timer: ReturnType<typeof setTimeout>
      record: {
        clientId: string
        viewport: { cols: number; rows: number } | null
        wasResizedToPhone: boolean
        previousCols: number | null
        previousRows: number | null
        subscribedAt: number
        lastActedAt: number
      }
    }
  >()

  // Preserve actual renderer pane geometry; phone-fit resizes overwrite ptySizes and must not become desktop restore baselines.
  protected lastRendererSizes = new Map<string, { cols: number; rows: number }>()

  // Desktop-fit notifications remeasure all panes, sometimes at wrong full width; suppress renderer resizes for 200ms after the server sets correct sizes.
  protected resizeSuppressedUntil = 0

  // Delay restore 300ms to avoid tab-switch thrashing; key by PTY so one client leaving two terminals retains both timers.
  protected pendingRestoreTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; clientId: string }
  >()

  // Inline resized events carry fresh scrollback and monotonic layout seq so mobile drops stale transitions (docs/mobile-terminal-layout-state-machine.md).
  protected resizeListeners = new Map<
    string,
    Set<
      (event: {
        cols: number
        rows: number
        displayMode: string
        reason: string
        seq?: number
      }) => void
    >
  >()

  // applyLayout alone writes layout, fit overrides and PTY resize; triggers enter enqueueLayout (docs/mobile-terminal-layout-state-machine.md).
  protected layouts = new Map<string, PtyLayoutState>()

  // Serialize resize awaits to preserve seq order; coalesce only same-kind/same-owner viewport ticks, retaining mode/floor changes and other owners for fairness.
  protected layoutQueues = new Map<string, LayoutQueueEntry>()

  // The first subscribe creates the layout entry; bypass the missing-entry short circuit until that enqueue resolves.
  protected freshSubscribeGuard = new Set<string>()

  protected stats: StatsCollector | null = null

  // Why: create and drift probes must share one fetch/freshness owner.
  protected readonly remoteFetches = new RuntimeRemoteFetchController()

  protected readonly worktreeBaseReconciliation = new RuntimeWorktreeBaseReconciliation(
    this.remoteFetches,
    () => this.notifier
  )

  protected readonly removeManagedWorktreeInFlight = new RuntimeWorktreeRemovalInFlight()
}
