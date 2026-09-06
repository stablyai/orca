import { BrowserGrabSessionController } from './browser-grab-session-controller'
import type { BrowserCertificateTrustController } from './browser-certificate-trust-controller'
import {
  createPageInitiatedTabBudget,
  type PageInitiatedTabBudget
} from './browser-page-initiated-tab-budget'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type {
  BrowserLoadError,
  BrowserSessionUserAgentMode
} from '../../shared/browser-workspace-types'
import { resolveBrowserRouteGuestPopupOpener } from './browser-route-guest-popup-ownership'
import type {
  ActiveDownload,
  AuthUserAgentOverrideState,
  PendingMainFrameNavigation,
  PendingPermissionEvent,
  PendingPopupEvent,
  BrowserGuestPolicy,
  BrowserManagerLoadError,
  PopupOwnerContext
} from './browser-manager-types'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent
} from '../../shared/browser-guest-events'
import type { BrowserGrabCancelReason } from '../../shared/browser-grab-types'
import { BrowserManagerViewportScrollState } from './browser-manager-viewport-scroll-state'

export abstract class BrowserManagerState extends BrowserManagerViewportScrollState {
  protected abstract attachGuestPolicies(
    guest: Electron.WebContents,
    inheritedOwnerContext?: PopupOwnerContext | null,
    policy?: BrowserGuestPolicy
  ): void

  protected abstract forwardOrQueuePopupEvent(
    guestWebContentsId: number,
    event: PendingPopupEvent
  ): void

  protected abstract cancelPendingDownloadsForGuest(guestWebContentsId: number): void

  protected abstract cleanupGuestPolicyAttachment(guestWebContentsId: number): void
  protected abstract notifyBrowserGuestStateChanged(webContentsId: number): void
  protected abstract buildLoadError(
    code: number,
    description: string,
    rawUrl: string
  ): BrowserLoadError
  protected abstract forwardOrQueueGuestLoadFailure(
    guestWebContentsId: number,
    loadError: BrowserManagerLoadError
  ): void
  protected abstract forwardOrQueuePermissionDenied(
    guestWebContentsId: number,
    event: PendingPermissionEvent
  ): void
  protected abstract flushPendingLoadFailure(browserTabId: string, guestWebContentsId: number): void
  protected abstract flushPendingPermissionEvents(
    browserTabId: string,
    guestWebContentsId: number
  ): void
  protected abstract flushPendingPopupEvents(browserTabId: string, guestWebContentsId: number): void
  protected abstract flushPendingDownloadRequests(
    browserTabId: string,
    guestWebContentsId: number
  ): void
  protected abstract setupContextMenu(browserTabId: string, guest: Electron.WebContents): void
  protected abstract setupGrabShortcut(browserTabId: string, guest: Electron.WebContents): void
  protected abstract setupShortcutForwarding(
    browserTabId: string,
    guest: Electron.WebContents
  ): void
  protected abstract setupMouseWheelZoomForwarding(
    browserTabId: string,
    guest: Electron.WebContents
  ): void
  protected abstract cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void
  protected abstract hasActiveGrabOp(browserTabId: string): boolean
  protected abstract unregisterGuest(browserTabId: string): void
  protected abstract cancelDownloadInternal(downloadId: string, reason: string): void
  protected abstract bindDownloadToTab(downloadId: string, browserTabId: string): void
  protected abstract flushDownloadSnapshot(downloadId: string): void
  protected abstract sendDownloadStarted(downloadId: string): void
  protected abstract sendDownloadProgress(
    browserTabId: string | null,
    payload: BrowserDownloadProgressEvent
  ): void
  protected abstract sendDownloadFinished(
    browserTabId: string | null,
    payload: BrowserDownloadFinishedEvent
  ): void
  protected abstract settleClientHostedDownload(
    download: ActiveDownload,
    status: BrowserDownloadFinishedEvent['status'],
    failure: string | null
  ): Promise<void>
  protected abstract finishDownloadInternal(
    downloadId: string,
    status: BrowserDownloadFinishedEvent['status'],
    error: string | null
  ): void
  protected abstract getDownloadReceivedBytes(item: Electron.DownloadItem): number
  protected abstract openLinkInOrcaTab(browserTabId: string, rawUrl: string): boolean

  protected settingsResolver:
    | (() => {
        keybindings?: KeybindingOverrides
        mobileEmulatorEnabled?: boolean
      })
    | null = null
  protected readonly webContentsIdByTabId = new Map<string, number>()
  // Why: reverse map gives O(1) guest→tab lookups on every mouse/load/permission/popup event.
  protected readonly tabIdByWebContentsId = new Map<number, string>()
  protected readonly popupOwnerContextByGuestId = new Map<number, PopupOwnerContext>()
  // Why: keyed by the opener tree's root so named child popups can't each mint a fresh tab quota.
  protected readonly pageInitiatedTabBudgetByRootGuestId = new Map<number, PageInitiatedTabBudget>()
  // Why: guests are keyed by page id but renderer visibility by workspace id; bridge the mismatch to activate the right tab before capture.
  protected readonly workspaceIdByPageId = new Map<string, string>()
  protected readonly sessionProfileIdByPageId = new Map<string, string | null>()
  protected readonly userAgentModeByPageId = new Map<string, BrowserSessionUserAgentMode>()
  // Why: serialize per-tab setViewportOverride so rapid toggles don't interleave CDP commands and leave emulation in a wrong state.
  protected readonly viewportOpsByTabId = new Map<string, Promise<unknown>>()
  // Why: presence means the preset requires a CDP UA override (installed or in flight), so navigation
  // can re-issue it against the target URL's identity.
  protected readonly viewportUaOverrideMobileByTabId = new Map<string, boolean>()
  // Why: the confirmed CDP identity outranks getUserAgent; pending intent keeps rapid navigations
  // ordered without claiming a failed write was installed.
  protected readonly authUserAgentOverrideStateByGuestId = new Map<
    number,
    AuthUserAgentOverrideState
  >()
  // Why: the in-flight main-frame navigation target, held only until commit or failure — getURL()
  // still reports the outgoing page until then. See resolveTabNavigationUrl.
  protected readonly pendingNavigationByGuestId = new Map<number, PendingMainFrameNavigation>()
  protected readonly contextMenuCleanupByTabId = new Map<string, () => void>()
  protected readonly grabShortcutCleanupByTabId = new Map<string, () => void>()
  protected readonly shortcutForwardingCleanupByTabId = new Map<string, () => void>()
  protected readonly mouseWheelZoomCleanupByTabId = new Map<string, () => void>()
  protected readonly annotationViewportBridgeOpsByTabId = new Map<string, Promise<unknown>>()
  protected readonly worktreeIdByTabId = new Map<string, string>()
  protected readonly policyAttachedGuestIds = new Set<number>()
  protected readonly offscreenGuestIds = new Set<number>()
  protected readonly policyCleanupByGuestId = new Map<number, () => void>()
  protected readonly clickedLinkFrameNameByGuestId = new Map<number, string>()
  protected readonly loadErrorsByGuestId = new Map<number, BrowserLoadError>()
  // Why: did-start-navigation hides the overlay optimistically; stash the cleared error so did-fail-load(-3) can restore an aborted nav.
  protected readonly clearedLoadErrorsByGuestId = new Map<number, BrowserLoadError>()
  protected browserGuestStateChangedListener: ((worktreeId: string) => void) | null = null
  protected certificateTrustController: BrowserCertificateTrustController | null = null
  protected shouldForwardDictationShortcut: (() => boolean) | null = null
  protected readonly pendingLoadFailuresByGuestId = new Map<
    number,
    { code: number; description: string; validatedUrl: string }
  >()
  protected readonly pendingPermissionEventsByGuestId = new Map<number, PendingPermissionEvent[]>()
  protected readonly pendingPopupEventsByGuestId = new Map<number, PendingPopupEvent[]>()
  protected readonly pendingDownloadIdsByGuestId = new Map<number, string[]>()
  protected readonly downloadsById = new Map<string, ActiveDownload>()
  protected readonly grabSessionController = new BrowserGrabSessionController()

  setDictationShortcutForwardingPredicate(predicate: (() => boolean) | null): void {
    this.shouldForwardDictationShortcut = predicate
  }

  setBrowserGuestStateChangedListener(listener: ((worktreeId: string) => void) | null): void {
    this.browserGuestStateChangedListener = listener
  }

  setCertificateTrustController(controller: BrowserCertificateTrustController): void {
    this.certificateTrustController = controller
  }

  installCertificateRequestGuard(session: Electron.Session): void {
    this.certificateTrustController?.installSessionRequestGuard(session)
  }

  removeCertificateRequestGuard(session: Electron.Session): void {
    this.certificateTrustController?.removeSessionRequestGuard(session)
  }

  setSettingsResolver(
    resolver: () => {
      keybindings?: KeybindingOverrides
      mobileEmulatorEnabled?: boolean
    }
  ): void {
    this.settingsResolver = resolver
  }

  // Why: a debugger detach clears every CDP override Chromium holds, including the Google auth-host
  // UA override, so the confirmed-override record must be dropped or the next auth navigation
  // believes the identity is still installed and skips the write.
  protected trackDebuggerDetachForAuthUserAgent(guest: Electron.WebContents): () => void {
    const onDetach = (): void => {
      this.authUserAgentOverrideStateByGuestId.delete(guest.id)
    }
    try {
      guest.debugger.on('detach', onDetach)
    } catch {
      /* debugger may be unavailable */
    }
    return () => {
      try {
        guest.debugger.off('detach', onDetach)
      } catch {
        /* guest may already be destroyed */
      }
    }
  }

  protected resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId: number): string | null {
    return this.resolvePopupOwnerContext(guestWebContentsId)?.browserTabId ?? null
  }

  protected resolvePopupOwnerContext(guestWebContentsId: number): PopupOwnerContext | null {
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    if (browserTabId) {
      return { browserTabId, rootGuestWebContentsId: guestWebContentsId }
    }
    // Route popups live in an Orca-built window, so they never pass through did-create-window and
    // have no inherited context; their owning page comes from the route popup registry instead.
    const routeOpenerWebContentsId = resolveBrowserRouteGuestPopupOpener(guestWebContentsId)
    if (routeOpenerWebContentsId !== null) {
      const openerTabId = this.tabIdByWebContentsId.get(routeOpenerWebContentsId)
      return openerTabId
        ? { browserTabId: openerTabId, rootGuestWebContentsId: routeOpenerWebContentsId }
        : null
    }
    const inherited = this.popupOwnerContextByGuestId.get(guestWebContentsId)
    if (
      inherited &&
      this.webContentsIdByTabId.get(inherited.browserTabId) === inherited.rootGuestWebContentsId
    ) {
      return inherited
    }
    this.popupOwnerContextByGuestId.delete(guestWebContentsId)
    return null
  }

  /** Shared across the whole opener tree, so a chain of popups draws from one budget. */
  protected tryConsumePageInitiatedTab(rootGuestWebContentsId: number): boolean {
    let budget = this.pageInitiatedTabBudgetByRootGuestId.get(rootGuestWebContentsId)
    if (!budget) {
      budget = createPageInitiatedTabBudget()
      this.pageInitiatedTabBudgetByRootGuestId.set(rootGuestWebContentsId, budget)
    }
    return budget.tryConsume(Date.now())
  }
}
