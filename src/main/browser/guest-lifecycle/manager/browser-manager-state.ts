import { BrowserGrabSessionController } from '../../element-grab/browser-grab-session-controller'
import type { BrowserCertificateTrustController } from '../../certificate-trust/browser-certificate-trust-controller'
import type { BrowserSiteDisplayController } from '../../site-settings/display/browser-site-display-controller'
import { createPageInitiatedTabBudget } from '../popups/browser-page-initiated-tab-budget'
import type { PageInitiatedTabBudget } from '../popups/browser-page-initiated-tab-budget'
import type { KeybindingOverrides } from '../../../../shared/keybindings/types'
import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'
import { resolveBrowserRouteGuestPopupOpener } from '../../routing/guest-authority/browser-route-guest-popup-ownership'
import type { BrowserPagePromptTarget } from '../prompts/browser-page-prompts'
import type { ActiveDownload } from './downloads/browser-active-download'
import type { CdpUserAgentOverrideState } from './navigation/browser-user-agent-override-state'
import type { PendingMainFrameNavigation } from './navigation/browser-main-frame-navigation'
import type { PendingPermissionEvent, PendingPopupEvent } from './browser-manager-event-forwarding'
import type { BrowserGuestPolicy } from './registration/browser-guest-policy-profile'
import type { PopupOwnerContext } from '../popups/browser-popup-ownership'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent
} from '../../../../shared/browser/guest-lifecycle/browser-guest-events'
import type { BrowserGrabCancelReason } from '../../../../shared/browser/element-grab/browser-grab-types'
import { BrowserManagerViewportScrollState } from './viewport/browser-manager-viewport-scroll-state'
import { BrowserGuestDevToolsDock } from '../devtools/browser-guest-devtools-dock'
import { createKeyedTrailingEdgeCoalescer } from '../../../runtime/client/events/keyed-trailing-edge-coalescer'

export type BrowserManagerSettings = {
  keybindings?: KeybindingOverrides
  mobileEmulatorEnabled?: boolean
}

/** A link a headless serve page asked to open as an Orca tab beside it. */
export type OffscreenBrowserTabOpenRequest = {
  worktreeId: string
  profileId: string | null
  url: string
  activate: boolean
  /** The paired client whose click or key press opened it, if one did. */
  pairedDeviceId: string | null
}

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
    loadError: BrowserLoadError
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
  protected abstract setupTargetUrlForwarding(
    browserTabId: string,
    guest: Electron.WebContents
  ): void
  protected abstract cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void
  protected abstract hasActiveGrabOp(browserTabId: string): boolean
  protected abstract unregisterGuest(
    browserTabId: string,
    reason?: 'page-closed' | 'guest-destroyed'
  ): void
  protected abstract cancelDownloadInternal(
    downloadId: string,
    reason: string,
    status?: 'canceled' | 'failed'
  ): void
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
  protected abstract isAwaitingDownloadFrom(
    guestWebContentsId: number,
    rootGuestWebContentsId: number
  ): boolean
  protected abstract openLinkInOrcaTab(
    browserTabId: string,
    rawUrl: string,
    activate?: boolean,
    agentOpened?: boolean
  ): boolean

  protected settingsResolver: (() => BrowserManagerSettings) | null = null
  protected readonly webContentsIdByTabId = new Map<string, number>()
  protected readonly tabIdByWebContentsId = new Map<number, string>()
  protected readonly popupOwnerContextByGuestId = new Map<number, PopupOwnerContext>()
  // A popup chain shares its root opener quota.
  protected readonly pageInitiatedTabBudgetByRootGuestId = new Map<number, PageInitiatedTabBudget>()
  // Capture activates by workspace ID while guests are keyed by page ID.
  protected readonly workspaceIdByPageId = new Map<string, string>()
  protected readonly sessionProfileIdByPageId = new Map<string, string | null>()
  // Serialize viewport changes so rapid toggles cannot interleave CDP commands.
  protected readonly viewportOpsByTabId = new Map<string, Promise<unknown>>()
  // Track pending and confirmed CDP identities without treating failed writes as installed.
  protected readonly cdpUserAgentOverrideStateByGuestId = new Map<
    number,
    CdpUserAgentOverrideState
  >()
  // getURL() names the outgoing page until commit; retain the in-flight target separately.
  protected readonly pendingNavigationByGuestId = new Map<number, PendingMainFrameNavigation>()
  protected readonly contextMenuCleanupByTabId = new Map<string, () => void>()
  protected readonly grabShortcutCleanupByTabId = new Map<string, () => void>()
  protected readonly shortcutForwardingCleanupByTabId = new Map<string, () => void>()
  protected readonly mouseWheelZoomCleanupByTabId = new Map<string, () => void>()
  protected readonly targetUrlCleanupByTabId = new Map<string, () => void>()
  protected readonly annotationViewportBridgeOpsByTabId = new Map<string, Promise<unknown>>()
  protected readonly worktreeIdByTabId = new Map<string, string>()
  protected readonly policyAttachedGuestIds = new Set<number>()
  protected readonly offscreenGuestIds = new Set<number>()
  protected readonly devToolsDock = new BrowserGuestDevToolsDock()
  protected readonly policyCleanupByGuestId = new Map<number, () => void>()
  protected readonly loadErrorsByGuestId = new Map<number, BrowserLoadError>()
  // Restore the optimistically hidden error if navigation aborts.
  protected readonly clearedLoadErrorsByGuestId = new Map<number, BrowserLoadError>()
  // Offscreen pages have no renderer to hold their icon for session-tab rows.
  protected readonly remoteTabFaviconUrlByGuestId = new Map<number, string>()
  protected browserGuestStateChangedListener: ((worktreeId: string) => void) | null = null
  // Title and spinner churn on offscreen pages publishes at most about once a second.
  protected readonly offscreenGuestStateNotices = createKeyedTrailingEdgeCoalescer(
    (webContentsId) => this.notifyBrowserGuestStateChanged(Number(webContentsId)),
    { flushMs: 250, maxWaitMs: 1000 }
  )
  protected offscreenTabOpener: ((request: OffscreenBrowserTabOpenRequest) => void) | null = null
  protected certificateTrustController: BrowserCertificateTrustController | null = null
  protected siteDisplayController: BrowserSiteDisplayController | null = null
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

  setOffscreenTabOpener(opener: ((request: OffscreenBrowserTabOpenRequest) => void) | null): void {
    this.offscreenTabOpener = opener
  }

  setCertificateTrustController(controller: BrowserCertificateTrustController): void {
    this.certificateTrustController = controller
  }

  setSiteDisplayController(controller: BrowserSiteDisplayController): void {
    this.siteDisplayController = controller
  }

  installCertificateRequestGuard(session: Electron.Session): void {
    this.certificateTrustController?.installSessionRequestGuard(session)
  }

  removeCertificateRequestGuard(session: Electron.Session): void {
    this.certificateTrustController?.removeSessionRequestGuard(session)
  }

  /** Orca's shortcut overrides; extension commands yield to every Orca shortcut. */
  getKeybindingOverrides(): KeybindingOverrides | undefined {
    return this.settingsResolver?.().keybindings
  }

  setSettingsResolver(resolver: () => BrowserManagerSettings): void {
    this.settingsResolver = resolver
  }

  // Detaching clears UA and device metrics; invalidate both cached records.
  protected trackDebuggerDetachForCdpOverrides(guest: Electron.WebContents): () => void {
    const onDetach = (): void => {
      this.cdpUserAgentOverrideStateByGuestId.delete(guest.id)
      const browserTabId = this.tabIdByWebContentsId.get(guest.id)
      if (browserTabId) {
        this.recordAppliedViewportOverride(browserTabId, guest.id, null)
      }
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

  getRendererContextForGuest(
    guestWebContentsId: number
  ): { browserPageId: string; renderer: Electron.WebContents } | null {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserPageId) {
      return null
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    return renderer ? { browserPageId, renderer } : null
  }

  resolvePagePromptTarget(guest: Electron.WebContents): BrowserPagePromptTarget | null {
    const context = this.getRendererContextForGuest(guest.id)
    if (context) {
      return context
    }
    // Loading can start before renderer registration.
    const awaitingRegistration =
      this.policyAttachedGuestIds.has(guest.id) &&
      !this.tabIdByWebContentsId.has(guest.id) &&
      !this.popupOwnerContextByGuestId.has(guest.id) &&
      !this.offscreenGuestIds.has(guest.id) &&
      guest.getType() === 'webview'
    return awaitingRegistration ? 'awaiting-registration' : null
  }

  protected resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId: number): string | null {
    return this.resolvePopupOwnerContext(guestWebContentsId)?.browserTabId ?? null
  }

  protected resolvePopupOwnerContext(guestWebContentsId: number): PopupOwnerContext | null {
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    if (browserTabId) {
      return { browserTabId, rootGuestWebContentsId: guestWebContentsId }
    }
    // Custom route popups skip did-create-window; resolve ownership through their registry.
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

  protected tryConsumePageInitiatedTab(rootGuestWebContentsId: number): boolean {
    let budget = this.pageInitiatedTabBudgetByRootGuestId.get(rootGuestWebContentsId)
    if (!budget) {
      budget = createPageInitiatedTabBudget()
      this.pageInitiatedTabBudgetByRootGuestId.set(rootGuestWebContentsId, budget)
    }
    return budget.tryConsume(Date.now())
  }
}
