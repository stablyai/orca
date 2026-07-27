/* eslint-disable max-lines -- Why: single privileged facade for guest registration, authorization, and lifecycle cleanup; keeps the browser security boundary in one file. */
import { randomUUID } from 'node:crypto'

import { shell, webContents } from 'electron'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken,
  toSecureCertificateEndpoint
} from '../../shared/browser-url'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../../shared/browser-guest-events'
import type {
  BrowserGrabCancelReason,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserGrabResult,
  BrowserGrabScreenshot
} from '../../shared/browser-grab-types'
import { buildGuestOverlayScript } from './grab-guest-script'
import { clampGrabPayload } from './browser-grab-payload'
import { captureSelectionScreenshot as captureGrabSelectionScreenshot } from './browser-grab-screenshot'
import { BrowserGrabSessionController } from './browser-grab-session-controller'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import {
  resolveRendererWebContents,
  setupGrabShortcutForwarding,
  setupGuestContextMenu,
  setupGuestMouseWheelZoomForwarding,
  setupGuestShortcutForwarding
} from './browser-guest-ui'
import { ANTI_DETECTION_SCRIPT } from './anti-detection'
import { openPopupWithOriginBar, type PopupChildWindowOptions } from './popup-origin-bar-window'
import {
  BROWSER_CLICKED_LINK_ROUTING_WORLD_ID,
  buildBrowserClickedLinkRoutingScript,
  buildBrowserIframeClickedLinkRoutingScript
} from './browser-clicked-link-routing'
import { cleanElectronUserAgent } from './browser-session-ua'
import type { BrowserViewportOverride } from '../../shared/types'
import {
  type BrowserAnnotationViewportBridgeOptions,
  BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
  buildBrowserAnnotationViewportBridgeScript
} from '../../shared/browser-annotation-viewport-bridge'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type { BrowserCertificateFailure, BrowserLoadError } from '../../shared/types'
import {
  BrowserCertificateTrustController,
  type ManagedBrowserGuestContext
} from './browser-certificate-trust-controller'

const AUTOMATION_VISIBILITY_ACQUIRE_TIMEOUT_MS = 2_000

function isChromiumInternalErrorUrl(url: string): boolean {
  return url.startsWith('chrome-error://')
}

function resolveWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallbackValue: T
): Promise<{ value: T; timedOut: boolean }> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<{ value: T; timedOut: boolean }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ value: fallbackValue, timedOut: true }), timeoutMs)
  })
  return Promise.race([
    promise.then((value) => ({ value, timedOut: false })),
    timeoutPromise
  ]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  })
}

function releaseAutomationVisibilityToken(renderer: Electron.WebContents, token: string): void {
  if (renderer.isDestroyed()) {
    return
  }
  renderer
    .executeJavaScript(
      `(function() {
        var bridge = window.__orcaBrowserAutomationVisibility;
        if (!bridge || typeof bridge.release !== 'function') return false;
        return bridge.release(${JSON.stringify(token)});
      })()`
    )
    .catch(() => {})
}

function cleanupLateAutomationVisibilityToken(
  renderer: Electron.WebContents,
  acquirePromise: Promise<unknown>
): void {
  acquirePromise
    .then((lateToken) => {
      if (typeof lateToken !== 'string' || lateToken.length === 0) {
        return
      }
      // Why: the lease is created before paint; if main's acquire timed out, release the late token so hidden webviews don't stay paintable.
      releaseAutomationVisibilityToken(renderer, lateToken)
    })
    .catch(() => {})
}

function createNoopRestoreForTimedOutAutomationAcquire(
  renderer: Electron.WebContents,
  acquirePromise: Promise<unknown>,
  timedOut: boolean
): () => void {
  if (timedOut) {
    cleanupLateAutomationVisibilityToken(renderer, acquirePromise)
  }
  return () => {}
}

function isAutomationVisibilityToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0
}

// Why: responsive sites UA-sniff; this is Chrome DevTools' default iPhone UA template with the real Chrome major spliced in to keep sec-ch-ua consistent (see setupClientHintsOverride).
function buildMobileUserAgent(chromeMajor: string): string {
  return `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeMajor}.0.0.0 Mobile/15E148 Safari/604.1`
}

function extractChromeMajor(ua: string): string {
  const match = ua.match(/Chrome\/(\d+)/)
  return match ? match[1] : '134'
}

export type BrowserGuestRegistration = {
  browserPageId?: string
  browserTabId?: string
  workspaceId?: string
  worktreeId?: string
  sessionProfileId?: string | null
  webContentsId: number
  rendererWebContentsId: number
}

type PendingPermissionEvent = Omit<BrowserPermissionDeniedEvent, 'browserPageId'>
type PendingPopupEvent = Omit<BrowserPopupEvent, 'browserPageId'>
type BrowserDownloadDoneState = 'completed' | 'cancelled' | 'interrupted'
type PopupOwnerContext = {
  browserTabId: string
  rootGuestWebContentsId: number
}
const SAFE_POPUP_WINDOW_OPTIONS = {
  alwaysOnTop: false,
  closable: true,
  focusable: true,
  frame: true,
  fullscreen: false,
  kiosk: false,
  modal: false,
  movable: true,
  opacity: 1,
  show: true,
  simpleFullscreen: false,
  skipTaskbar: false,
  titleBarStyle: 'default',
  transparent: false,
  // Why: Electron applies these before createWindow; feature strings/opener inheritance must not relax the child's isolation.
  webPreferences: {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false
  }
} satisfies Electron.BrowserWindowConstructorOptions

type ActiveDownload = {
  downloadId: string
  guestWebContentsId: number
  browserTabId: string | null
  rendererWebContentsId: number | null
  origin: string
  filename: string
  totalBytes: number | null
  mimeType: string | null
  item: Electron.DownloadItem
  savePath: string
  reservationKey: string | null
  receivedBytes: number
  transientState: BrowserDownloadProgressEvent['state']
  terminalEvent: BrowserDownloadFinishedEvent | null
  startedSent: boolean
  cleanup: (() => void) | null
}

function safeOrigin(rawUrl: string): string {
  const external = normalizeExternalBrowserUrl(rawUrl)
  const urlToParse = external ?? rawUrl
  try {
    return new URL(urlToParse).origin
  } catch {
    return external ?? 'unknown'
  }
}

export class BrowserManager {
  private settingsResolver:
    | (() => {
        keybindings?: KeybindingOverrides
        mobileEmulatorEnabled?: boolean
      })
    | null = null
  private readonly webContentsIdByTabId = new Map<string, number>()
  // Why: reverse map gives O(1) guest→tab lookups on every mouse/load/permission/popup event.
  private readonly tabIdByWebContentsId = new Map<number, string>()
  private readonly popupOwnerContextByGuestId = new Map<number, PopupOwnerContext>()
  // Why: guests are keyed by page id but renderer visibility by workspace id; bridge the mismatch to activate the right tab before capture.
  private readonly workspaceIdByPageId = new Map<string, string>()
  private readonly sessionProfileIdByPageId = new Map<string, string | null>()
  private readonly rendererWebContentsIdByTabId = new Map<string, number>()
  // Why: serialize per-tab setViewportOverride so rapid toggles don't interleave CDP commands and leave emulation in a wrong state.
  private readonly viewportOpsByTabId = new Map<string, Promise<unknown>>()
  private readonly contextMenuCleanupByTabId = new Map<string, () => void>()
  private readonly grabShortcutCleanupByTabId = new Map<string, () => void>()
  private readonly shortcutForwardingCleanupByTabId = new Map<string, () => void>()
  private readonly mouseWheelZoomCleanupByTabId = new Map<string, () => void>()
  private readonly annotationViewportBridgeOpsByTabId = new Map<string, Promise<unknown>>()
  private readonly worktreeIdByTabId = new Map<string, string>()
  private readonly policyAttachedGuestIds = new Set<number>()
  private readonly offscreenGuestIds = new Set<number>()
  private readonly policyCleanupByGuestId = new Map<number, () => void>()
  private readonly clickedLinkFrameNameByGuestId = new Map<number, string>()
  private readonly loadErrorsByGuestId = new Map<number, BrowserLoadError>()
  // Why: did-start-navigation hides the overlay optimistically; stash the cleared error so did-fail-load(-3) can restore an aborted nav.
  private readonly clearedLoadErrorsByGuestId = new Map<number, BrowserLoadError>()
  private browserGuestStateChangedListener: ((worktreeId: string) => void) | null = null
  private certificateTrustController: BrowserCertificateTrustController | null = null
  private shouldForwardDictationShortcut: (() => boolean) | null = null
  private readonly pendingLoadFailuresByGuestId = new Map<
    number,
    { code: number; description: string; validatedUrl: string }
  >()
  private readonly pendingPermissionEventsByGuestId = new Map<number, PendingPermissionEvent[]>()
  private readonly pendingPopupEventsByGuestId = new Map<number, PendingPopupEvent[]>()
  private readonly pendingDownloadIdsByGuestId = new Map<number, string[]>()
  private readonly downloadsById = new Map<string, ActiveDownload>()
  private readonly grabSessionController = new BrowserGrabSessionController()

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

  // Why: addScriptToEvaluateOnNewDocument (CDP) is the only reliable pre-page-script hook per nav; executeJavaScript ran on the old page context.
  private injectAntiDetection(guest: Electron.WebContents): () => void {
    let disposed = false
    let reattachTimer: ReturnType<typeof setTimeout> | null = null

    const attach = (): void => {
      if (disposed || guest.isDestroyed()) {
        return
      }
      try {
        if (!guest.debugger.isAttached()) {
          guest.debugger.attach('1.3')
        }
        void guest.debugger
          .sendCommand('Page.enable', {})
          .then(() =>
            guest.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
              source: ANTI_DETECTION_SCRIPT
            })
          )
          .catch(() => {})
      } catch {
        /* best-effort — debugger may be unavailable */
      }
    }

    // Why: proxy/bridge stop detaches the debugger and drops injections; re-attach (500ms delay to avoid racing a mid-restart) to keep overrides.
    const onDetach = (): void => {
      if (!disposed && !guest.isDestroyed() && reattachTimer === null) {
        reattachTimer = setTimeout(() => {
          reattachTimer = null
          attach()
        }, 500)
      }
    }

    try {
      attach()
      guest.debugger.on('detach', onDetach)
    } catch {
      /* best-effort */
    }

    return () => {
      disposed = true
      if (reattachTimer !== null) {
        clearTimeout(reattachTimer)
        reattachTimer = null
      }
      try {
        guest.debugger.off('detach', onDetach)
      } catch {
        /* guest may already be destroyed */
      }
    }
  }

  private resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId: number): string | null {
    return this.resolvePopupOwnerContext(guestWebContentsId)?.browserTabId ?? null
  }

  private resolvePopupOwnerContext(guestWebContentsId: number): PopupOwnerContext | null {
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    if (browserTabId) {
      return { browserTabId, rootGuestWebContentsId: guestWebContentsId }
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

  private resolveRendererForBrowserTab(browserTabId: string): Electron.WebContents | null {
    const rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (!rendererWebContentsId) {
      return null
    }
    const renderer = webContents.fromId(rendererWebContentsId)
    if (!renderer || renderer.isDestroyed()) {
      return null
    }
    return renderer
  }

  // Why: screenshots target page ids but visible chrome is keyed by workspace id; activate by workspace or the webview stays hidden and capture times out.
  async ensureWebviewVisible(guestWebContentsId: number): Promise<() => void> {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserPageId) {
      return () => {}
    }
    const browserWorkspaceId = this.workspaceIdByPageId.get(browserPageId) ?? browserPageId
    const worktreeId = this.worktreeIdByTabId.get(browserPageId) ?? null
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    if (!renderer || renderer.isDestroyed()) {
      return () => {}
    }

    const prev = await renderer
      .executeJavaScript(
        `(function() {
          var store = window.__store;
          if (!store) return null;
          var state = store.getState();
          var prevTabType = state.activeTabType;
          var prevActiveWorktreeId = state.activeWorktreeId || null;
          var prevActiveBrowserWorkspaceId = state.activeBrowserTabId || null;
          var prevActiveBrowserPageId = null;
          var prevFocusedGroupTabId = null;
          var targetWorktreeId = ${JSON.stringify(worktreeId)};
          var browserWorkspaceId = ${JSON.stringify(browserWorkspaceId)};
          var browserPageId = ${JSON.stringify(browserPageId)};
          var browserTabsByWorktree = state.browserTabsByWorktree || {};

          if (prevActiveWorktreeId) {
            var prevFocusedGroupId = (state.activeGroupIdByWorktree || {})[prevActiveWorktreeId];
            var prevGroups = (state.groupsByWorktree || {})[prevActiveWorktreeId] || [];
            for (var pg = 0; pg < prevGroups.length; pg++) {
              if (prevGroups[pg].id === prevFocusedGroupId) {
                prevFocusedGroupTabId = prevGroups[pg].activeTabId;
                break;
              }
            }
          }

          if (prevActiveBrowserWorkspaceId) {
            for (var prevWtId in browserTabsByWorktree) {
              var prevBrowserTabs = browserTabsByWorktree[prevWtId] || [];
              for (var pbt = 0; pbt < prevBrowserTabs.length; pbt++) {
                if (prevBrowserTabs[pbt].id === prevActiveBrowserWorkspaceId) {
                  prevActiveBrowserPageId = prevBrowserTabs[pbt].activePageId || null;
                  break;
                }
              }
              if (prevActiveBrowserPageId) break;
            }
          }

          if (
            targetWorktreeId &&
            prevActiveWorktreeId !== targetWorktreeId &&
            typeof state.setActiveWorktree === 'function'
          ) {
            state.setActiveWorktree(targetWorktreeId);
            state = store.getState();
          }

          var foundWorkspace = null;
          for (var wtId in browserTabsByWorktree) {
            var tabs = browserTabsByWorktree[wtId] || [];
            for (var i = 0; i < tabs.length; i++) {
              if (tabs[i].id === browserWorkspaceId) {
                foundWorkspace = tabs[i];
                if (!targetWorktreeId) {
                  targetWorktreeId = wtId;
                }
                break;
              }
            }
            if (foundWorkspace) break;
          }

          var hasTargetPage = false;
          var targetPages = (state.browserPagesByWorkspace || {})[browserWorkspaceId] || [];
          for (var pageIndex = 0; pageIndex < targetPages.length; pageIndex++) {
            if (targetPages[pageIndex].id === browserPageId) {
              hasTargetPage = true;
              break;
            }
          }

          if (foundWorkspace) {
            if (typeof state.setActiveBrowserTab === 'function') {
              state.setActiveBrowserTab(browserWorkspaceId);
              state = store.getState();
            } else {
              var allTabs = state.unifiedTabsByWorktree || {};
              var found = null;
              for (var unifiedWtId in allTabs) {
                var unifiedTabs = allTabs[unifiedWtId] || [];
                for (var unifiedIndex = 0; unifiedIndex < unifiedTabs.length; unifiedIndex++) {
                  if (
                    unifiedTabs[unifiedIndex].contentType === 'browser' &&
                    unifiedTabs[unifiedIndex].entityId === browserWorkspaceId
                  ) {
                    found = unifiedTabs[unifiedIndex];
                    break;
                  }
                }
                if (found) break;
              }
              if (found) {
                state.activateTab(found.id);
              }
              state.setActiveTabType('browser');
              state = store.getState();
            }
            // Why: activating the workspace alone is not enough for screenshot
            // capture when a browser workspace contains multiple pages. The
            // compositor only paints the currently mounted page guest.
            if (
              hasTargetPage &&
              foundWorkspace.activePageId !== browserPageId &&
              typeof state.setActiveBrowserPage === 'function'
            ) {
              state.setActiveBrowserPage(browserWorkspaceId, browserPageId);
              state = store.getState();
            }
          }

          return {
            prevTabType: prevTabType,
            prevActiveWorktreeId: prevActiveWorktreeId,
            prevActiveBrowserWorkspaceId: prevActiveBrowserWorkspaceId,
            prevActiveBrowserPageId: prevActiveBrowserPageId,
            prevFocusedGroupTabId: prevFocusedGroupTabId,
            targetWorktreeId: targetWorktreeId,
            targetBrowserWorkspaceId: foundWorkspace ? browserWorkspaceId : null,
            targetBrowserPageId: foundWorkspace && hasTargetPage ? browserPageId : null
          };
        })()`
      )
      .catch(() => null)

    const needsRestore =
      prev &&
      (prev.prevTabType !== 'browser' ||
        prev.prevActiveWorktreeId !== prev.targetWorktreeId ||
        prev.prevFocusedGroupTabId !== null ||
        prev.prevActiveBrowserWorkspaceId !== prev.targetBrowserWorkspaceId ||
        prev.prevActiveBrowserPageId !== prev.targetBrowserPageId)

    if (!needsRestore) {
      return () => {}
    }

    return () => {
      if (!prev || !renderer || renderer.isDestroyed()) {
        return
      }
      renderer
        .executeJavaScript(
          `(function() {
            var store = window.__store;
            if (!store) return;
            var state = store.getState();
            if (
              ${JSON.stringify(prev?.prevActiveWorktreeId)} &&
              ${JSON.stringify(prev?.prevActiveWorktreeId)} !==
                ${JSON.stringify(prev?.targetWorktreeId)} &&
              typeof state.setActiveWorktree === 'function'
            ) {
              state.setActiveWorktree(${JSON.stringify(prev?.prevActiveWorktreeId)});
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} !==
                ${JSON.stringify(prev?.targetBrowserWorkspaceId)} &&
              typeof state.setActiveBrowserTab === 'function'
            ) {
              state.setActiveBrowserTab(${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)});
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserPageId)} &&
              ${JSON.stringify(prev?.prevActiveBrowserPageId)} !==
                ${JSON.stringify(prev?.targetBrowserPageId)} &&
              typeof state.setActiveBrowserPage === 'function'
            ) {
              // Why: Orca remembers the last browser workspace/page even when
              // the user is currently in terminal/editor view. Screenshot prep
              // temporarily switches that hidden browser selection state, so
              // restore it independently of the visible tab type.
              state.setActiveBrowserPage(
                ${JSON.stringify(prev?.prevActiveBrowserWorkspaceId)},
                ${JSON.stringify(prev?.prevActiveBrowserPageId)}
              );
              state = store.getState();
            }
            if (
              ${JSON.stringify(prev?.prevTabType)} !== 'browser' &&
              ${JSON.stringify(prev?.prevFocusedGroupTabId)}
            ) {
              state.activateTab(${JSON.stringify(prev?.prevFocusedGroupTabId)});
            }
            if (${JSON.stringify(prev?.prevTabType)} !== 'browser') {
              state.setActiveTabType(${JSON.stringify(prev?.prevTabType)});
            }
          })()`
        )
        .catch(() => {})
    }
  }

  async acquireAutomationVisibility(guestWebContentsId: number): Promise<() => void> {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserPageId) {
      return () => {}
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    if (!renderer || renderer.isDestroyed()) {
      return () => {}
    }

    // Why: agent commands need a paintable webview for lazy-loading sites without stealing the user's visible tab.
    const acquirePromise = renderer
      .executeJavaScript(
        `(async function() {
            var bridge = window.__orcaBrowserAutomationVisibility;
            if (!bridge || typeof bridge.acquire !== 'function') return null;
            return await bridge.acquire(${JSON.stringify(browserPageId)});
          })()`
      )
      .catch(() => null)
    const { value: token, timedOut } = await resolveWithTimeout(
      acquirePromise,
      AUTOMATION_VISIBILITY_ACQUIRE_TIMEOUT_MS,
      null
    )

    if (!isAutomationVisibilityToken(token)) {
      return createNoopRestoreForTimedOutAutomationAcquire(renderer, acquirePromise, timedOut)
    }

    return () => {
      releaseAutomationVisibilityToken(renderer, token)
    }
  }

  attachGuestPolicies(
    guest: Electron.WebContents,
    inheritedOwnerContext: PopupOwnerContext | null = null
  ): void {
    if (this.policyAttachedGuestIds.has(guest.id)) {
      return
    }
    this.policyAttachedGuestIds.add(guest.id)
    if (inheritedOwnerContext) {
      this.popupOwnerContextByGuestId.set(guest.id, inheritedOwnerContext)
    }
    // Why: only the primary embedded browser converts new-tab clicks to Orca tabs; OAuth child windows keep native link behavior.
    const clickedLinkFrameName = inheritedOwnerContext
      ? null
      : `__orca_clicked_link_foreground_${randomUUID()}`
    if (clickedLinkFrameName) {
      this.clickedLinkFrameNameByGuestId.set(guest.id, clickedLinkFrameName)
    }
    let clickedLinkRoutingActive = Boolean(clickedLinkFrameName)

    // Why: bot detectors probe APIs that differ in Electron webviews; inject overrides each load so manual browsing passes.
    const disposeAntiDetection = this.injectAntiDetection(guest)

    // Why: disable throttling so background screenshots still get frames; else the compositor stalls and capture returns empty.
    guest.setBackgroundThrottling(false)
    const installClickedLinkRouting = (): void => {
      if (!clickedLinkRoutingActive || !clickedLinkFrameName || guest.isDestroyed()) {
        return
      }
      // Why: an isolated-world listener labels real anchor clicks without exposing the frame name to page scripts.
      void guest
        .executeJavaScriptInIsolatedWorld(
          BROWSER_CLICKED_LINK_ROUTING_WORLD_ID,
          [
            {
              // Why: mobile emulation spoofs the UA as iOS, so use the real host platform from main for modifier routing.
              code: buildBrowserClickedLinkRoutingScript(
                clickedLinkFrameName,
                process.platform === 'darwin'
              )
            }
          ],
          false
        )
        .catch(() => {})
    }
    if (clickedLinkFrameName) {
      guest.on('dom-ready', installClickedLinkRouting)
    }
    const pendingIframeRoutingInstalls = new Map<Electron.WebFrameMain, () => void>()
    const iframeFrameNameByFrame = new Map<Electron.WebFrameMain, string>()
    const iframeFrameByFrameName = new Map<string, Electron.WebFrameMain>()
    const clearIframeFrameName = (frame: Electron.WebFrameMain): void => {
      const name = iframeFrameNameByFrame.get(frame)
      if (!name) {
        return
      }
      iframeFrameNameByFrame.delete(frame)
      iframeFrameByFrameName.delete(name)
    }
    const installIframeClickedLinkRouting = (frame: Electron.WebFrameMain): void => {
      clearIframeFrameName(frame)
      if (!clickedLinkRoutingActive || frame.isDestroyed()) {
        return
      }
      const name = `__orca_clicked_link_iframe_foreground_${randomUUID()}`
      iframeFrameNameByFrame.set(frame, name)
      iframeFrameByFrameName.set(name, frame)
      // Why: child-frame tokens live in the page world, so consume after one trusted click and replace before the next.
      void frame
        .executeJavaScript(
          buildBrowserIframeClickedLinkRoutingScript(name, process.platform === 'darwin'),
          false
        )
        .catch(() => {
          if (iframeFrameNameByFrame.get(frame) === name) {
            clearIframeFrameName(frame)
          }
        })
    }
    const handleFrameCreated = (
      _event: Electron.Event,
      { frame }: Electron.FrameCreatedDetails
    ): void => {
      if (!clickedLinkFrameName || !frame || frame.parent === null) {
        return
      }
      for (const knownFrame of iframeFrameNameByFrame.keys()) {
        if (knownFrame.isDestroyed()) {
          clearIframeFrameName(knownFrame)
        }
      }
      const installAfterDomReady = (): void => {
        pendingIframeRoutingInstalls.delete(frame)
        installIframeClickedLinkRouting(frame)
      }
      pendingIframeRoutingInstalls.set(frame, installAfterDomReady)
      frame.once('dom-ready', installAfterDomReady)
    }
    if (clickedLinkFrameName) {
      guest.on('frame-created', handleFrameCreated)
    }
    const handleDidCreateWindow = (window: Electron.BrowserWindow): void => {
      // Why: popup descendants inherit the opener's owner context but must not replace its primary registration.
      this.attachGuestPolicies(window.webContents, this.resolvePopupOwnerContext(guest.id))
    }
    guest.on('did-create-window', handleDidCreateWindow)
    guest.setWindowOpenHandler(({ url, frameName }) => {
      const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guest.id)
      const browserUrl = normalizeBrowserNavigationUrl(url)
      const externalUrl = normalizeExternalBrowserUrl(url)
      const expectedClickedLinkFrameName = this.clickedLinkFrameNameByGuestId.get(guest.id)
      const iframeFrame = frameName ? iframeFrameByFrameName.get(frameName) : undefined
      let isClickedLink = Boolean(
        expectedClickedLinkFrameName && frameName === expectedClickedLinkFrameName
      )
      if (!isClickedLink && iframeFrame) {
        isClickedLink = true
        clearIframeFrameName(iframeFrame)
        queueMicrotask(() => installIframeClickedLinkRouting(iframeFrame))
      }

      if (isClickedLink) {
        if (browserTabId && browserUrl && this.openLinkInOrcaTab(browserTabId, browserUrl)) {
          this.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(browserUrl),
            action: 'opened-in-orca'
          })
        }
        // Why: a recognized gesture must never fall through to a native popup if its renderer vanished mid-click.
        return { action: 'deny' }
      }

      // Why: file URLs are fine for in-pane previews, but must not spawn native child windows targeting local paths.
      const canOpenAsChild = Boolean(externalUrl || browserUrl === ORCA_BROWSER_BLANK_URL)
      if (browserTabId && canOpenAsChild) {
        // Why: OAuth may request size/position, but content must not create deceptive or inescapable native chrome.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: SAFE_POPUP_WINDOW_OPTIONS,
          // Why: default child windows lack an address bar; host in an Orca origin-bar window so the destination is verifiable.
          createWindow: (options: PopupChildWindowOptions) =>
            this.createPopupChildWindowWithOriginBar(guest, url, options)
        }
      } else if (externalUrl) {
        // Why: Kagi target=_blank popup URLs still contain the bearer token; redact before handing to the OS browser.
        void shell.openExternal(redactKagiSessionToken(externalUrl))
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(externalUrl),
          action: 'opened-external'
        })
      } else {
        // Why: popup URLs can carry auth redirects/one-time tokens; surface only sanitized origin metadata.
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(url),
          action: 'blocked'
        })
      }
      return { action: 'deny' }
    })

    const navigationGuard = (event: Electron.Event, url: string): void => {
      // Why: Turnstile loads challenge resources via blob:; blocking them trips error 600010. Allow only http(s) blobs, not opaque ones.
      if (url.startsWith('blob:https://') || url.startsWith('blob:http://')) {
        return
      }
      // Why: initial file:// attach is allowed for user-opened previews, but block later file:// redirects so remote pages can't probe the FS.
      if (url.startsWith('file:')) {
        event.preventDefault()
        return
      }
      if (!normalizeBrowserNavigationUrl(url)) {
        // Why: will-attach-webview only validates the initial src; keep enforcing the allowlist on later navs.
        event.preventDefault()
      }
    }

    const didFailLoadHandler = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame) {
        return
      }
      const browserPageId = this.tabIdByWebContentsId.get(guest.id)
      const certificateFailure = browserPageId
        ? this.certificateTrustController?.getFailure(browserPageId)
        : null
      if (
        certificateFailure &&
        toSecureCertificateEndpoint(validatedURL || guest.getURL()) ===
          toSecureCertificateEndpoint(certificateFailure.origin)
      ) {
        // Why: this cancellation carries the existing cert warning; don't overwrite it with ERR_ABORTED copy.
        return
      }
      if (errorCode === -3) {
        // Why: an aborted nav never committed; restore the error did-start-navigation cleared so it isn't lost.
        const clearedError = this.clearedLoadErrorsByGuestId.get(guest.id)
        if (clearedError !== undefined) {
          this.clearedLoadErrorsByGuestId.delete(guest.id)
          this.loadErrorsByGuestId.set(guest.id, clearedError)
          this.forwardOrQueueGuestLoadFailure(guest.id, clearedError)
          this.notifyBrowserGuestStateChanged(guest.id)
        }
        return
      }
      this.clearedLoadErrorsByGuestId.delete(guest.id)
      const loadError = this.buildLoadError(
        errorCode,
        errorDescription || 'This site could not be reached.',
        validatedURL || guest.getURL() || 'about:blank'
      )
      this.loadErrorsByGuestId.set(guest.id, loadError)
      this.forwardOrQueueGuestLoadFailure(guest.id, loadError)
      this.notifyBrowserGuestStateChanged(guest.id)
    }

    const didStartNavigationHandler = (
      _event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || isChromiumInternalErrorUrl(url)) {
        return
      }
      this.certificateTrustController?.onMainFrameNavigationStarted(guest.id)
      // Why: a pre-registration failure belongs only to its own nav; a replacement nav must not replay it.
      this.pendingLoadFailuresByGuestId.delete(guest.id)
      const activeError = this.loadErrorsByGuestId.get(guest.id)
      if (activeError === undefined) {
        // Why: no error to hide; drop any stale stash so a later abort can't resurrect an old failure.
        this.clearedLoadErrorsByGuestId.delete(guest.id)
        return
      }
      this.clearedLoadErrorsByGuestId.set(guest.id, activeError)
      this.loadErrorsByGuestId.delete(guest.id)
      this.notifyBrowserGuestStateChanged(guest.id)
    }

    const didNavigateHandler = (_event: Electron.Event, url: string): void => {
      // Why: a committed nav makes the did-start-navigation stash obsolete; drop it so a later ERR_ABORTED can't restore an error over it.
      this.clearedLoadErrorsByGuestId.delete(guest.id)
      this.certificateTrustController?.onMainFrameNavigationCommitted(guest.id, url)
    }

    guest.on('will-navigate', navigationGuard)
    guest.on('will-redirect', navigationGuard)
    guest.on('did-start-navigation', didStartNavigationHandler)
    guest.on('did-navigate', didNavigateHandler)
    guest.on('did-fail-load', didFailLoadHandler)
    const handleDestroyed = (): void => {
      // Why: guests can die before renderer registration, else attach-time closures leak until shutdown.
      this.cleanupGuestPolicyAttachment(guest.id)
    }
    guest.on('destroyed', handleDestroyed)

    // Why: store cleanup so unregisterGuest can drop these listeners on teardown and let the WebContents wrapper GC.
    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeAntiDetection()
      try {
        guest.off('destroyed', handleDestroyed)
        guest.off('did-create-window', handleDidCreateWindow)
        if (clickedLinkFrameName) {
          clickedLinkRoutingActive = false
          guest.off('dom-ready', installClickedLinkRouting)
          guest.off('frame-created', handleFrameCreated)
          for (const [frame, install] of pendingIframeRoutingInstalls) {
            if (!frame.isDestroyed()) {
              frame.off('dom-ready', install)
            }
          }
          pendingIframeRoutingInstalls.clear()
          iframeFrameNameByFrame.clear()
          iframeFrameByFrameName.clear()
        }
      } catch {
        // guest may already be destroyed
      }
      if (!guest.isDestroyed()) {
        guest.off('will-navigate', navigationGuard)
        guest.off('will-redirect', navigationGuard)
        guest.off('did-start-navigation', didStartNavigationHandler)
        guest.off('did-navigate', didNavigateHandler)
        guest.off('did-fail-load', didFailLoadHandler)
      }
    })
  }

  private createPopupChildWindowWithOriginBar(
    openerGuest: Electron.WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions
  ): Electron.WebContents {
    const popup = openPopupWithOriginBar(options, targetUrl)
    // Why: Electron emits no did-create-window for createWindow children, so attach the opener's policies here.
    this.attachGuestPolicies(
      popup.contentWebContents,
      this.resolvePopupOwnerContext(openerGuest.id)
    )
    this.forwardOrQueuePopupEvent(openerGuest.id, {
      origin: safeOrigin(targetUrl),
      action: 'opened-in-orca'
    })
    // Why: match Electron's child-window lifecycle so closing the owning tab doesn't orphan session-bearing popups.
    const closePopupWithOpener = (): void => popup.close()
    openerGuest.once('destroyed', closePopupWithOpener)
    popup.onClosed(() => {
      if (!openerGuest.isDestroyed()) {
        openerGuest.off('destroyed', closePopupWithOpener)
      }
    })
    return popup.contentWebContents
  }

  private retireStaleGuestWebContents(previousWebContentsId: number): void {
    // Why: after a renderer-process swap, stop the dead guest id resolving to the live page so stale callbacks don't hit the wrong session.
    this.cleanupGuestPolicyAttachment(previousWebContentsId)
    this.tabIdByWebContentsId.delete(previousWebContentsId)
  }

  private cleanupGuestPolicyAttachment(guestWebContentsId: number): void {
    const isPrimaryGuest = this.tabIdByWebContentsId.has(guestWebContentsId)
    this.certificateTrustController?.onGuestRetired(guestWebContentsId)
    const policyCleanup = this.policyCleanupByGuestId.get(guestWebContentsId)
    if (policyCleanup) {
      policyCleanup()
      this.policyCleanupByGuestId.delete(guestWebContentsId)
    }
    this.policyAttachedGuestIds.delete(guestWebContentsId)
    this.clickedLinkFrameNameByGuestId.delete(guestWebContentsId)
    this.offscreenGuestIds.delete(guestWebContentsId)
    this.popupOwnerContextByGuestId.delete(guestWebContentsId)
    // Why: a popup must stop inheriting authorization the moment its owner retires, before Chromium destroys the child.
    if (isPrimaryGuest) {
      for (const [popupGuestId, owner] of this.popupOwnerContextByGuestId) {
        if (owner.rootGuestWebContentsId === guestWebContentsId) {
          this.popupOwnerContextByGuestId.delete(popupGuestId)
        }
      }
    }
    this.pendingLoadFailuresByGuestId.delete(guestWebContentsId)
    this.loadErrorsByGuestId.delete(guestWebContentsId)
    this.clearedLoadErrorsByGuestId.delete(guestWebContentsId)
    this.pendingPermissionEventsByGuestId.delete(guestWebContentsId)
    this.pendingPopupEventsByGuestId.delete(guestWebContentsId)
    this.cancelPendingDownloadsForGuest(guestWebContentsId)
  }

  registerGuest({
    browserPageId,
    browserTabId: legacyBrowserTabId,
    workspaceId,
    worktreeId,
    sessionProfileId,
    webContentsId,
    rendererWebContentsId
  }: BrowserGuestRegistration): boolean {
    const browserTabId = browserPageId ?? legacyBrowserTabId
    if (!browserTabId) {
      return false
    }
    // Why: on guest-surface swap, cancel any grab bound to the old guest's listeners so it doesn't strand on a stale webContents.
    this.cancelGrabOp(browserTabId, 'evicted')

    const previousCleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }

    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return false
    }

    // Why: don't trust the renderer-sent id blindly — a compromised renderer could pass the main window's id; only accept webview guests.
    if (guest.getType() !== 'webview') {
      return false
    }
    if (!this.policyAttachedGuestIds.has(webContentsId)) {
      // Why: only trust guests that passed attach-time policy install, or a renderer could point us at an arbitrary webview.
      return false
    }

    const previousWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (previousWebContentsId !== undefined && previousWebContentsId !== webContentsId) {
      this.retireStaleGuestWebContents(previousWebContentsId)
    }
    this.webContentsIdByTabId.set(browserTabId, webContentsId)
    this.tabIdByWebContentsId.set(webContentsId, browserTabId)
    if (workspaceId) {
      this.workspaceIdByPageId.set(browserTabId, workspaceId)
    }
    this.sessionProfileIdByPageId.set(browserTabId, sessionProfileId ?? null)
    this.rendererWebContentsIdByTabId.set(browserTabId, rendererWebContentsId)
    if (worktreeId) {
      this.worktreeIdByTabId.set(browserTabId, worktreeId)
    }
    this.certificateTrustController?.onGuestRegistered(webContentsId, browserTabId)

    this.setupContextMenu(browserTabId, guest)
    this.setupGrabShortcut(browserTabId, guest)
    this.setupShortcutForwarding(browserTabId, guest)
    this.setupMouseWheelZoomForwarding(browserTabId, guest)
    this.flushPendingLoadFailure(browserTabId, webContentsId)
    this.flushPendingPermissionEvents(browserTabId, webContentsId)
    this.flushPendingPopupEvents(browserTabId, webContentsId)
    this.flushPendingDownloadRequests(browserTabId, webContentsId)
    return true
  }

  unregisterGuest(browserTabId: string): void {
    // Why: teardown mid-grab must cancel it so the renderer gets a signal, not a dangling Promise.
    this.cancelGrabOp(browserTabId, 'evicted')

    // Why: remove attachGuestPolicies listeners so their guest-WebContents closures don't block GC.
    const guestWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (guestWebContentsId !== undefined) {
      this.cleanupGuestPolicyAttachment(guestWebContentsId)
    }

    const cleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (cleanup) {
      cleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }
    const shortcutCleanup = this.grabShortcutCleanupByTabId.get(browserTabId)
    if (shortcutCleanup) {
      shortcutCleanup()
      this.grabShortcutCleanupByTabId.delete(browserTabId)
    }
    const fwdCleanup = this.shortcutForwardingCleanupByTabId.get(browserTabId)
    if (fwdCleanup) {
      fwdCleanup()
      this.shortcutForwardingCleanupByTabId.delete(browserTabId)
    }
    const mouseWheelZoomCleanup = this.mouseWheelZoomCleanupByTabId.get(browserTabId)
    if (mouseWheelZoomCleanup) {
      mouseWheelZoomCleanup()
      this.mouseWheelZoomCleanupByTabId.delete(browserTabId)
    }
    // Why: downloads are per-tab chrome; closing the tab must cancel active writes, not orphan them.
    for (const [downloadId, download] of this.downloadsById.entries()) {
      if (download.browserTabId === browserTabId && !download.terminalEvent) {
        this.cancelDownloadInternal(downloadId, 'Tab closed before download completed.')
      }
    }
    const wcId = this.webContentsIdByTabId.get(browserTabId)
    if (wcId !== undefined) {
      this.tabIdByWebContentsId.delete(wcId)
    }
    this.webContentsIdByTabId.delete(browserTabId)
    this.rendererWebContentsIdByTabId.delete(browserTabId)
    this.workspaceIdByPageId.delete(browserTabId)
    this.sessionProfileIdByPageId.delete(browserTabId)
    this.worktreeIdByTabId.delete(browserTabId)
    // Why: drop the viewport-op chain so the Map doesn't retain a promise keyed to a destroyed guest.
    this.viewportOpsByTabId.delete(browserTabId)
    this.annotationViewportBridgeOpsByTabId.delete(browserTabId)
  }

  // Why: headless orca serve has no <webview> window; back pages with offscreen WebContents and skip the webview-only setup.
  registerOffscreenGuest({
    browserPageId,
    worktreeId,
    sessionProfileId,
    webContentsId
  }: {
    browserPageId: string
    worktreeId?: string
    sessionProfileId?: string | null
    webContentsId: number
  }): void {
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return
    }
    // Why: offscreen pages have no renderer webview listeners, so main owns their load-failure lifecycle.
    this.offscreenGuestIds.add(webContentsId)
    this.attachGuestPolicies(guest)
    const previousWebContentsId = this.webContentsIdByTabId.get(browserPageId)
    if (previousWebContentsId !== undefined && previousWebContentsId !== webContentsId) {
      this.retireStaleGuestWebContents(previousWebContentsId)
    }
    this.webContentsIdByTabId.set(browserPageId, webContentsId)
    this.tabIdByWebContentsId.set(webContentsId, browserPageId)
    this.sessionProfileIdByPageId.set(browserPageId, sessionProfileId ?? null)
    if (worktreeId) {
      this.worktreeIdByTabId.set(browserPageId, worktreeId)
    }
    this.certificateTrustController?.onGuestRegistered(webContentsId, browserPageId)
  }

  unregisterAll(): void {
    // Cancel all active grab ops before tearing down registrations
    this.grabSessionController.cancelAll('evicted')
    for (const downloadId of this.downloadsById.keys()) {
      this.cancelDownloadInternal(downloadId, 'Orca is shutting down.')
    }
    browserDownloadDestinationReservations.clear()
    for (const browserTabId of this.webContentsIdByTabId.keys()) {
      this.unregisterGuest(browserTabId)
    }
    this.policyAttachedGuestIds.clear()
    this.offscreenGuestIds.clear()
    // Why: unregisterGuest skips guests that were policy-attached but never registered; invoke their cleanup closures here.
    for (const cleanup of this.policyCleanupByGuestId.values()) {
      cleanup()
    }
    this.policyCleanupByGuestId.clear()
    this.clickedLinkFrameNameByGuestId.clear()
    this.tabIdByWebContentsId.clear()
    this.popupOwnerContextByGuestId.clear()
    this.worktreeIdByTabId.clear()
    this.sessionProfileIdByPageId.clear()
    this.pendingLoadFailuresByGuestId.clear()
    this.loadErrorsByGuestId.clear()
    this.clearedLoadErrorsByGuestId.clear()
    this.pendingPermissionEventsByGuestId.clear()
    this.pendingPopupEventsByGuestId.clear()
    this.pendingDownloadIdsByGuestId.clear()
    this.mouseWheelZoomCleanupByTabId.clear()
    this.annotationViewportBridgeOpsByTabId.clear()
  }

  getGuestWebContentsId(browserTabId: string): number | null {
    return this.webContentsIdByTabId.get(browserTabId) ?? null
  }

  getWebContentsIdByTabId(): Map<string, number> {
    return this.webContentsIdByTabId
  }

  getWorktreeIdForTab(browserTabId: string): string | undefined {
    return this.worktreeIdByTabId.get(browserTabId)
  }

  getSessionProfileIdForTab(browserTabId: string): string | null {
    return this.sessionProfileIdByPageId.get(browserTabId) ?? null
  }

  getBrowserPageLoadError(browserPageId: string): BrowserLoadError | null {
    const webContentsId = this.webContentsIdByTabId.get(browserPageId)
    return webContentsId === undefined
      ? null
      : (this.loadErrorsByGuestId.get(webContentsId) ?? null)
  }

  getBrowserPageCertificateFailure(browserPageId: string): BrowserCertificateFailure | null {
    return this.certificateTrustController?.getFailure(browserPageId) ?? null
  }

  getManagedBrowserGuestContext(webContentsId: number): ManagedBrowserGuestContext | null {
    if (this.popupOwnerContextByGuestId.has(webContentsId)) {
      return null
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId) ?? null
    const offscreen = this.offscreenGuestIds.has(webContentsId)
    if (!offscreen && !this.policyAttachedGuestIds.has(webContentsId)) {
      return null
    }
    if (!offscreen) {
      const guest = webContents.fromId(webContentsId)
      if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') {
        return null
      }
    }
    return {
      browserPageId,
      worktreeId: browserPageId ? (this.worktreeIdByTabId.get(browserPageId) ?? null) : null,
      sessionProfileId: browserPageId
        ? (this.sessionProfileIdByPageId.get(browserPageId) ?? null)
        : null,
      owner: offscreen ? 'offscreen' : 'desktop-webview'
    }
  }

  // Why: centralize Kagi session-token redaction so every load-error path (did-fail-load, cert failure) strips it.
  private buildLoadError(code: number, description: string, rawUrl: string): BrowserLoadError {
    return {
      code,
      description,
      validatedUrl: redactKagiSessionToken(rawUrl)
    }
  }

  notifyCertificateFailureChanged(
    webContentsId: number,
    failure: BrowserCertificateFailure | null,
    navigationUrl?: string
  ): void {
    if (failure && navigationUrl) {
      const loadError = this.buildLoadError(failure.errorCode ?? -1, failure.error, navigationUrl)
      this.loadErrorsByGuestId.set(webContentsId, loadError)
      this.forwardOrQueueGuestLoadFailure(webContentsId, loadError)
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId)
    if (!browserPageId) {
      return
    }
    if (this.offscreenGuestIds.has(webContentsId)) {
      this.notifyBrowserGuestStateChanged(webContentsId)
      return
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    renderer?.send('browser:certificate-failure-changed', { browserPageId, failure })
  }

  private notifyBrowserGuestStateChanged(webContentsId: number): void {
    if (!this.offscreenGuestIds.has(webContentsId)) {
      return
    }
    const browserPageId = this.tabIdByWebContentsId.get(webContentsId)
    const worktreeId = browserPageId ? this.worktreeIdByTabId.get(browserPageId) : null
    if (worktreeId) {
      // Why: runs inside an Electron guest event dispatch, so an escaping throw would be a fatal uncaught exception.
      try {
        this.browserGuestStateChangedListener?.(worktreeId)
      } catch (error) {
        console.error('[browser-manager] browserGuestStateChanged listener failed', error)
      }
    }
  }

  notifyPermissionDenied(args: {
    guestWebContentsId: number
    permission: string
    rawUrl: string
  }): void {
    this.forwardOrQueuePermissionDenied(args.guestWebContentsId, {
      permission: args.permission,
      origin: safeOrigin(args.rawUrl)
    })
  }

  handleGuestWillDownload(args: { guestWebContentsId: number; item: Electron.DownloadItem }): void {
    const { guestWebContentsId, item } = args
    const downloadId = randomUUID()
    const requestedFilename = (() => {
      try {
        return item.getFilename() || 'download'
      } catch {
        return 'download'
      }
    })()
    const totalBytes = (() => {
      try {
        const total = item.getTotalBytes()
        return total > 0 ? total : null
      } catch {
        return null
      }
    })()
    const mimeType = (() => {
      try {
        const mime = item.getMimeType()
        return mime || null
      } catch {
        return null
      }
    })()
    const origin = (() => {
      try {
        return safeOrigin(item.getURL())
      } catch {
        return 'unknown'
      }
    })()

    const destination = (() => {
      try {
        return browserDownloadDestinationReservations.reserve(requestedFilename)
      } catch (error) {
        console.error('[browser-download] Failed to choose download destination:', error)
        return null
      }
    })()

    const fallbackSavePath = destination?.savePath ?? ''

    const download: ActiveDownload = {
      downloadId,
      guestWebContentsId,
      browserTabId: null,
      rendererWebContentsId: null,
      origin,
      filename: destination?.filename ?? requestedFilename,
      totalBytes,
      mimeType,
      item,
      savePath: fallbackSavePath,
      reservationKey: destination?.reservationKey ?? null,
      receivedBytes: 0,
      transientState: null,
      terminalEvent: null,
      startedSent: false,
      cleanup: null
    }
    this.downloadsById.set(downloadId, download)

    const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (browserTabId) {
      this.bindDownloadToTab(downloadId, browserTabId)
    } else {
      const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId) ?? []
      pending.push(downloadId)
      this.pendingDownloadIdsByGuestId.set(guestWebContentsId, pending)
    }

    if (!destination) {
      this.finishDownloadInternal(downloadId, 'failed', 'Could not choose a Downloads file name.')
      try {
        item.cancel()
      } catch {
        // Why: with no destination Chromium must not keep writing invisibly; cancel is best-effort after surfacing the failure.
      }
      return
    }

    try {
      item.setSavePath(destination.savePath)
    } catch (error) {
      console.error('[browser-download] Failed to set download destination:', error)
      this.finishDownloadInternal(downloadId, 'failed', 'Failed to set download destination.')
      try {
        item.cancel()
      } catch {
        // Why: a failed setSavePath can leave Electron partially finalized; cancel is best-effort after the UI is made terminal.
      }
      return
    }

    const updatedHandler = (_event: Electron.Event, state: 'progressing' | 'interrupted'): void => {
      download.receivedBytes = this.getDownloadReceivedBytes(download.item)
      download.transientState = state
      this.sendDownloadProgress(download.browserTabId, {
        browserPageId: download.browserTabId ?? undefined,
        downloadId: download.downloadId,
        receivedBytes: download.receivedBytes,
        totalBytes: download.totalBytes,
        state
      })
    }
    const doneHandler = (_event: Electron.Event, state: BrowserDownloadDoneState): void => {
      const status: BrowserDownloadFinishedEvent['status'] =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'canceled' : 'failed'
      this.finishDownloadInternal(
        download.downloadId,
        status,
        status === 'failed'
          ? state === 'interrupted'
            ? 'Download was interrupted.'
            : 'Download failed.'
          : null
      )
    }
    download.cleanup = (): void => {
      try {
        download.item.off('updated', updatedHandler)
        download.item.off('done', doneHandler)
      } catch {
        // Why: a completed DownloadItem may already be finalized; keep cleanup best-effort so teardown never crashes main.
      }
    }
    item.on('updated', updatedHandler)
    item.once('done', doneHandler)

    if (browserTabId) {
      this.sendDownloadStarted(downloadId)
    }
  }

  cancelDownload(args: { downloadId: string; senderWebContentsId: number }): boolean {
    const download = this.downloadsById.get(args.downloadId)
    if (!download || download.rendererWebContentsId !== args.senderWebContentsId) {
      return false
    }
    this.cancelDownloadInternal(args.downloadId, 'Canceled.')
    return true
  }

  // Why: guests are isolated from Orca's preload bridge, so main owns the devtools escape hatch after a tab→guest lookup.
  async openDevTools(browserTabId: string): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return false
    }
    guest.openDevTools({ mode: 'detach' })
    return true
  }

  // Why: emulate viewport via CDP; never detach the debugger here or per-guest overrides (addScriptToEvaluateOnNewDocument) are cleared.
  async setViewportOverride(
    browserTabId: string,
    override: BrowserViewportOverride | null
  ): Promise<boolean> {
    // Why: chain per-tab so rapid toggles don't interleave CDP commands and the last-requested override wins.
    const prev = this.viewportOpsByTabId.get(browserTabId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.doSetViewportOverrideImpl(browserTabId, override))
    this.viewportOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      // Why: only clear if we're still the tail; a later call may have replaced the entry, and deleting would break serialization.
      if (this.viewportOpsByTabId.get(browserTabId) === next) {
        this.viewportOpsByTabId.delete(browserTabId)
      }
    }
  }

  async setAnnotationViewportBridge(
    browserTabId: string,
    options: BrowserAnnotationViewportBridgeOptions
  ): Promise<boolean> {
    const prev = this.annotationViewportBridgeOpsByTabId.get(browserTabId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.doSetAnnotationViewportBridgeImpl(browserTabId, options))
    this.annotationViewportBridgeOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      if (this.annotationViewportBridgeOpsByTabId.get(browserTabId) === next) {
        this.annotationViewportBridgeOpsByTabId.delete(browserTabId)
      }
    }
  }

  private async doSetAnnotationViewportBridgeImpl(
    browserTabId: string,
    options: BrowserAnnotationViewportBridgeOptions
  ): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return false
    }

    try {
      // Why: run the scroll bridge in an isolated world so page scripts can't read the per-tab token or tamper with it.
      await guest.executeJavaScriptInIsolatedWorld(
        BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
        [{ code: buildBrowserAnnotationViewportBridgeScript(options) }],
        false
      )
      return true
    } catch {
      return false
    }
  }

  private async doSetViewportOverrideImpl(
    browserTabId: string,
    override: BrowserViewportOverride | null
  ): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return false
    }

    try {
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach('1.3')
      }
    } catch (err) {
      // Why: attach throws if DevTools is open on the guest; log context so this failure mode is diagnosable.
      console.warn('[browser-manager] setViewportOverride: failed to attach debugger', {
        browserTabId,
        webContentsId,
        error: err instanceof Error ? err.message : String(err)
      })
      return false
    }

    const dbg = guest.debugger
    try {
      if (override) {
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: override.width,
          height: override.height,
          deviceScaleFactor: override.deviceScaleFactor,
          mobile: override.mobile
        })
        await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: override.mobile,
          maxTouchPoints: override.mobile ? 5 : 0
        })
        if (override.mobile) {
          const chromeMajor = extractChromeMajor(cleanElectronUserAgent(guest.getUserAgent()))
          // Why: userAgentMetadata must accompany the mobile UA so client hints match, or bot-detection flags the desktop-hint leak.
          await dbg.sendCommand('Emulation.setUserAgentOverride', {
            userAgent: buildMobileUserAgent(chromeMajor),
            userAgentMetadata: {
              brands: [
                { brand: 'Google Chrome', version: chromeMajor },
                { brand: 'Chromium', version: chromeMajor },
                { brand: 'Not/A)Brand', version: '24' }
              ],
              fullVersionList: [
                { brand: 'Google Chrome', version: `${chromeMajor}.0.0.0` },
                { brand: 'Chromium', version: `${chromeMajor}.0.0.0` },
                { brand: 'Not/A)Brand', version: '24.0.0.0' }
              ],
              fullVersion: `${chromeMajor}.0.0.0`,
              platform: 'iOS',
              platformVersion: '17.0',
              architecture: '',
              model: 'iPhone',
              mobile: true
            }
          })
        } else {
          // Why: desktop presets still need the clean (non-Electron) UA so Cloudflare/Turnstile don't flag the session.
          await dbg.sendCommand('Emulation.setUserAgentOverride', {
            userAgent: cleanElectronUserAgent(guest.getUserAgent())
          })
        }
      } else {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {})
        await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: false,
          maxTouchPoints: 0
        })
        // Why: passing an empty string restores the session default UA.
        await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' })
      }
      return true
    } catch {
      return false
    }
  }

  // --- Browser Context Grab — main-owned operations ---

  /** Validate that the sender owns browserTabId; returns the guest WebContents or null. */
  getAuthorizedGuest(
    browserTabId: string,
    senderWebContentsId: number
  ): Electron.WebContents | null {
    const registeredRenderer = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (registeredRenderer == null || registeredRenderer !== senderWebContentsId) {
      return null
    }
    const guestId = this.webContentsIdByTabId.get(browserTabId)
    if (guestId == null) {
      return null
    }
    const guest = webContents.fromId(guestId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return null
    }
    return guest
  }

  /** Returns true if a grab operation is currently active for this tab. */
  hasActiveGrabOp(browserTabId: string): boolean {
    return this.grabSessionController.hasActiveGrabOp(browserTabId)
  }

  /** Enable/disable grab mode for a tab: on enable inject the overlay runtime, on disable cancel any active grab op. */
  async setGrabMode(
    browserTabId: string,
    enabled: boolean,
    guest: Electron.WebContents
  ): Promise<boolean> {
    if (!enabled) {
      this.cancelGrabOp(browserTabId, 'user')
      return true
    }
    // Why: inject the overlay runtime eagerly on arm so the hover UI appears instantly; re-injection is idempotent/safe.
    try {
      await guest.executeJavaScript(buildGuestOverlayScript('arm'))
      return true
    } catch {
      return false
    }
  }

  /**
   * Await a single grab selection on the given tab; resolves once on click, cancel, or error.
   *
   * Why in-guest: before-input-event fires only for keyboard (not mouse) on guests, so the overlay hit-catcher consumes the click.
   */
  awaitGrabSelection(
    browserTabId: string,
    opId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabResult> {
    return this.grabSessionController.awaitGrabSelection(browserTabId, opId, guest)
  }

  /** Cancel an active grab operation for the given tab. */
  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    this.grabSessionController.cancelGrabOp(browserTabId, reason)
  }

  /** Capture a screenshot of the guest surface, optionally cropped to the given CSS-pixel rect. */
  async captureSelectionScreenshot(
    _browserTabId: string,
    rect: BrowserGrabRect,
    guest: Electron.WebContents
  ): Promise<BrowserGrabScreenshot | null> {
    return captureGrabSelectionScreenshot(rect, guest)
  }

  /** Extract the hovered element's payload without disrupting the active grab overlay/awaitClick listener. */
  async extractHoverPayload(
    _browserTabId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabPayload | null> {
    try {
      const rawPayload = await guest.executeJavaScript(buildGuestOverlayScript('extractHover'))
      if (!rawPayload || typeof rawPayload !== 'object') {
        return null
      }
      return clampGrabPayload(rawPayload)
    } catch {
      return null
    }
  }

  private setupContextMenu(browserTabId: string, guest: Electron.WebContents): void {
    this.contextMenuCleanupByTabId.set(
      browserTabId,
      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: (tabId) => this.resolveRendererForBrowserTab(tabId)
      })
    )
  }

  // Why: forward grab's Cmd/Ctrl+C from a focused guest only when no edit field/selection is active, so native copy still works.
  private setupGrabShortcut(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.grabShortcutCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.grabShortcutCleanupByTabId.delete(browserTabId)
    }

    this.grabShortcutCleanupByTabId.set(
      browserTabId,
      setupGrabShortcutForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
        hasActiveGrabOp: (tabId) => this.hasActiveGrabOp(tabId),
        getKeybindings: () => this.settingsResolver?.().keybindings
      })
    )
  }

  // Why: a focused webview guest is a separate process, so its key events never reach the renderer; intercept and forward app shortcuts.
  private setupShortcutForwarding(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.shortcutForwardingCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.shortcutForwardingCleanupByTabId.delete(browserTabId)
    }

    this.shortcutForwardingCleanupByTabId.set(
      browserTabId,
      setupGuestShortcutForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
        shouldForwardDictationShortcut: () => this.shouldForwardDictationShortcut?.() ?? false,
        isMobileEmulatorEnabled: () => this.settingsResolver?.().mobileEmulatorEnabled !== false,
        getKeybindings: () => this.settingsResolver?.().keybindings
      })
    )
  }

  private setupMouseWheelZoomForwarding(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.mouseWheelZoomCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.mouseWheelZoomCleanupByTabId.delete(browserTabId)
    }

    this.mouseWheelZoomCleanupByTabId.set(
      browserTabId,
      setupGuestMouseWheelZoomForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId)
      })
    )
  }

  private forwardOrQueueGuestLoadFailure(
    guestWebContentsId: number,
    loadError: { code: number; description: string; validatedUrl: string }
  ): void {
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    if (!browserTabId) {
      // Why: a failure can arrive before the tab is registered; queue by guest ID so registerGuest can replay it.
      this.pendingLoadFailuresByGuestId.set(guestWebContentsId, loadError)
      return
    }
    this.sendGuestLoadFailure(browserTabId, loadError)
  }

  private forwardOrQueuePermissionDenied(
    guestWebContentsId: number,
    event: PendingPermissionEvent
  ): void {
    const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      const pending = this.pendingPermissionEventsByGuestId.get(guestWebContentsId) ?? []
      pending.push(event)
      if (pending.length > 5) {
        pending.shift()
      }
      this.pendingPermissionEventsByGuestId.set(guestWebContentsId, pending)
      return
    }
    this.sendPermissionDenied(browserTabId, event)
  }

  private flushPendingPermissionEvents(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingPermissionEventsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingPermissionEventsByGuestId.delete(guestWebContentsId)
    for (const event of pending) {
      this.sendPermissionDenied(browserTabId, event)
    }
  }

  private sendPermissionDenied(browserTabId: string, event: PendingPermissionEvent): void {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:permission-denied', {
      browserPageId: browserTabId,
      ...event
    } satisfies BrowserPermissionDeniedEvent)
  }

  private forwardOrQueuePopupEvent(guestWebContentsId: number, event: PendingPopupEvent): void {
    const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      const pending = this.pendingPopupEventsByGuestId.get(guestWebContentsId) ?? []
      pending.push(event)
      if (pending.length > 5) {
        pending.shift()
      }
      this.pendingPopupEventsByGuestId.set(guestWebContentsId, pending)
      return
    }
    this.sendPopupEvent(browserTabId, event)
  }

  private flushPendingPopupEvents(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingPopupEventsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingPopupEventsByGuestId.delete(guestWebContentsId)
    for (const event of pending) {
      this.sendPopupEvent(browserTabId, event)
    }
  }

  private sendPopupEvent(browserTabId: string, event: PendingPopupEvent): void {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:popup', {
      browserPageId: browserTabId,
      ...event
    } satisfies BrowserPopupEvent)
  }

  private bindDownloadToTab(downloadId: string, browserTabId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    download.browserTabId = browserTabId
    download.rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId) ?? null
  }

  private flushPendingDownloadRequests(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingDownloadIdsByGuestId.delete(guestWebContentsId)
    for (const downloadId of pending) {
      this.bindDownloadToTab(downloadId, browserTabId)
      this.flushDownloadSnapshot(downloadId)
    }
  }

  private flushDownloadSnapshot(downloadId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    this.sendDownloadStarted(downloadId)
    if (download.receivedBytes > 0 || download.transientState) {
      this.sendDownloadProgress(download.browserTabId, {
        browserPageId: download.browserTabId ?? undefined,
        downloadId: download.downloadId,
        receivedBytes: download.receivedBytes,
        totalBytes: download.totalBytes,
        state: download.transientState
      })
    }
    if (download.terminalEvent) {
      this.sendDownloadFinished(download.browserTabId, {
        ...download.terminalEvent,
        browserPageId: download.browserTabId ?? undefined
      })
      this.downloadsById.delete(downloadId)
    }
  }

  private sendDownloadStarted(downloadId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download?.browserTabId) {
      return
    }
    if (download.startedSent) {
      return
    }
    const renderer = this.resolveRendererForBrowserTab(download.browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-requested', {
      browserPageId: download.browserTabId,
      downloadId: download.downloadId,
      origin: download.origin,
      filename: download.filename,
      totalBytes: download.totalBytes,
      mimeType: download.mimeType,
      savePath: download.savePath,
      status: 'downloading'
    } satisfies BrowserDownloadRequestedEvent)
    download.startedSent = true
  }

  private sendDownloadProgress(
    browserTabId: string | null,
    payload: BrowserDownloadProgressEvent
  ): void {
    if (!browserTabId) {
      return
    }
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-progress', payload)
  }

  private sendDownloadFinished(
    browserTabId: string | null,
    payload: BrowserDownloadFinishedEvent
  ): void {
    if (!browserTabId) {
      return
    }
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-finished', payload)
  }

  private cancelDownloadInternal(downloadId: string, reason: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }

    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }
    const shouldSendCancel = !download.terminalEvent

    try {
      download.item.cancel()
    } catch {
      // Why: cancel() can throw on an already-finalized item; best-effort since UI state is authoritative.
    }

    if (shouldSendCancel) {
      this.finishDownloadInternal(downloadId, 'canceled', reason || null)
      return
    }

    this.downloadsById.delete(downloadId)
  }

  private finishDownloadInternal(
    downloadId: string,
    status: BrowserDownloadFinishedEvent['status'],
    error: string | null
  ): void {
    const download = this.downloadsById.get(downloadId)
    if (!download || download.terminalEvent) {
      return
    }

    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }
    browserDownloadDestinationReservations.release(download.reservationKey)
    download.reservationKey = null
    const event: BrowserDownloadFinishedEvent = {
      browserPageId: download.browserTabId ?? undefined,
      downloadId: download.downloadId,
      status,
      savePath: download.savePath || null,
      error
    }
    download.terminalEvent = event
    if (download.browserTabId) {
      this.sendDownloadStarted(downloadId)
      this.sendDownloadFinished(download.browserTabId, event)
      this.downloadsById.delete(downloadId)
    }
  }

  private cancelPendingDownloadsForGuest(guestWebContentsId: number): void {
    const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId)
    this.pendingDownloadIdsByGuestId.delete(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    for (const downloadId of pending) {
      const download = this.downloadsById.get(downloadId)
      if (!download) {
        continue
      }
      if (download.terminalEvent) {
        this.downloadsById.delete(downloadId)
        continue
      }
      this.cancelDownloadInternal(downloadId, 'Browser page closed before download could be shown.')
      const afterCancel = this.downloadsById.get(downloadId)
      if (afterCancel?.terminalEvent && !afterCancel.browserTabId) {
        this.downloadsById.delete(downloadId)
      }
    }
  }

  private getDownloadReceivedBytes(item: Electron.DownloadItem): number {
    try {
      return Math.max(0, item.getReceivedBytes())
    } catch {
      return 0
    }
  }

  private flushPendingLoadFailure(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingLoadFailuresByGuestId.get(guestWebContentsId)
    if (!pending) {
      return
    }
    this.pendingLoadFailuresByGuestId.delete(guestWebContentsId)
    this.sendGuestLoadFailure(browserTabId, pending)
  }

  private sendGuestLoadFailure(
    browserTabId: string,
    loadError: { code: number; description: string; validatedUrl: string }
  ): void {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }

    // Why: redact Kagi session tokens before the renderer persists validatedUrl to disk.
    renderer.send('browser:guest-load-failed', {
      browserPageId: browserTabId,
      loadError: {
        ...loadError,
        validatedUrl: redactKagiSessionToken(loadError.validatedUrl)
      }
    })
  }

  private openLinkInOrcaTab(browserTabId: string, rawUrl: string): boolean {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return false
    }
    const normalizedUrl = normalizeBrowserNavigationUrl(rawUrl)
    if (!normalizedUrl || normalizedUrl === ORCA_BROWSER_BLANK_URL) {
      return false
    }
    // Why: only the renderer owns Orca's worktree/tab model; main forwards a validated URL, never letting guest content mutate it.
    renderer.send('browser:open-link-in-orca-tab', {
      browserPageId: browserTabId,
      url: normalizedUrl
    })
    return true
  }
}

export const browserManager = new BrowserManager()
export const browserCertificateTrustController = new BrowserCertificateTrustController({
  resolveManagedGuestContext: (webContentsId) =>
    browserManager.getManagedBrowserGuestContext(webContentsId),
  resolveWebContentsIdForPage: (browserPageId) =>
    browserManager.getGuestWebContentsId(browserPageId),
  resolveWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  onFailureChanged: (webContentsId, failure, navigationUrl) =>
    browserManager.notifyCertificateFailureChanged(webContentsId, failure, navigationUrl)
})
browserManager.setCertificateTrustController(browserCertificateTrustController)
