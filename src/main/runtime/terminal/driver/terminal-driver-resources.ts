import type { RuntimeServiceCommandSurface } from '../../runtime-service-command-surface'
import { resolveRemoteCliBrowserScopeSelector } from '../../desktop-browser-bridge/remote-cli-browser-scope'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { RuntimeAccountController } from '../../runtime-account-controller'
import type { BrowserNetworkExecutionHost } from '../../../../shared/browser-client-host-protocol'
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
  abstract getAuthoritativeWindow(): BrowserWindow
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

  // Why: per-PTY driver state. The "driver" is whoever currently owns the
  // input/resize floor. While `kind === 'mobile'` the desktop renderer drops
  // xterm.onData/onResize and shows the lock banner; `terminal.send` /
  // `pty:write` and `pty:resize` IPC handlers also drop desktop-side calls
  // server-side as defense-in-depth. The `clientId` carried on the mobile
  // variant is the most recent mobile actor — used by
  // `applyMobileDisplayMode` to pick the active phone-fit viewport. See
  // docs/mobile-presence-lock.md.
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
      getAgentBrowserBridge: () => this.agentBrowserBridge,
      resolveWorktreeSelector: (selector) =>
        resolveRemoteCliBrowserScopeSelector(selector) ?? this.resolveWorktreeSelector(selector),
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

  // Why: tests and diagnostic seams replace only screencast startup; ordinary edge methods stay pre-bound.
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

  // Why: resubscribe-grace window. When the last mobile subscriber for a
  // PTY unsubscribes, we hold the driver=mobile{clientId} state and the
  // inner-map record open for ~250ms. If the same (ptyId, clientId)
  // re-subscribes inside the window — typically because the mobile app
  // tore down the stream to reconfigure (rare with the new
  // updateMobileViewport path, but still possible on reconnects, network
  // hiccups, or older client builds) — we cancel the deferred idle and
  // restore-timer so the desktop banner doesn't flash and the new
  // subscriber doesn't capture an already-phone-fitted PTY size as its
  // restore baseline. Keyed by ptyId; carries the timer plus the snapshot
  // of the leaving subscriber so we can re-insert it on cancel. See
  // docs/mobile-presence-lock.md.
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

  // Why: tracks the last PTY size set by the desktop renderer (via pty:resize
  // IPC). Unlike ptySizes (which is overwritten by server-side phone-fit
  // resizes), this map preserves the actual pane geometry. Used as the
  // preferred source for previousCols so desktop restore uses the correct
  // split-pane width instead of a stale full-width value.
  protected lastRendererSizes = new Map<string, { cols: number; rows: number }>()

  // Why: when a desktop-fit override change fires, the desktop renderer's
  // re-render cascade (triggered by setOverrideTick) runs safeFit on ALL
  // panes — not just the affected one. Background tab panes get measured at
  // full-width (214) instead of their correct split width (105). The stale
  // pty:resize IPCs overwrite both the actual PTY size and lastRendererSizes.
  // This global window suppresses ALL pty:resize for 200ms after any
  // desktop-fit notification. The server has already set the correct PTY
  // size via ptyController.resize(), so desktop renderer resizes during
  // this window are redundant (for the restored pane) or wrong (collateral).
  protected resizeSuppressedUntil = 0

  // Why: delays PTY restore by 300ms after mobile unsubscribe so rapid tab
  // switches don't cause unnecessary resize thrashing. Keyed by clientId
  // Why: keyed by ptyId so each PTY gets its own independent restore timer.
  // The old clientId-keyed design lost timers when two PTYs were unsubscribed
  // back-to-back (only the last timer survived).
  protected pendingRestoreTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; clientId: string }
  >()

  // Why: inline resize events replace the unsubscribe→resubscribe pattern.
  // Listeners are notified when mode changes or desktop restores, allowing
  // the subscribe stream to emit a 'resized' event with fresh scrollback.
  // `seq` is the layout state-machine sequence number bumped on every
  // applyLayout success; mobile clients use it to drop stale events that
  // arrive after a newer transition. See docs/mobile-terminal-layout-state-machine.md.
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

  // Why: per-PTY layout state machine. `applyLayout` is the sole writer of
  // `layouts`, `terminalFitOverrides`, and `ptyController.resize`; every
  // trigger method routes through `enqueueLayout`. The monotonic `seq` is
  // emitted on the mobile subscribe stream so clients can drop stale events.
  // See docs/mobile-terminal-layout-state-machine.md.
  protected layouts = new Map<string, PtyLayoutState>()

  // Why: per-PTY async serialization queue for applyLayout. Without
  // serialization, two concurrent triggers can interleave around the
  // ptyController.resize await and bump seq in the wrong order, defeating
  // seq-as-truth. Coalesces same-kind same-owner viewport ticks so the
  // keyboard-show/hide animation doesn't queue 10+ resizes; mode flips,
  // take-floor, and different-owner targets always append (preserves
  // multi-mobile fairness). See docs/mobile-terminal-layout-state-machine.md
  // "enqueueLayout coalescing".
  protected layoutQueues = new Map<string, LayoutQueueEntry>()

  // Why: gate so enqueueLayout's "no layouts entry" short-circuit doesn't
  // fire on the very first transition for a PTY (where the entry doesn't
  // exist yet *because* we're about to create it). `handleMobileSubscribe`
  // adds the ptyId before calling enqueueLayout and removes it after the
  // call resolves.
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
