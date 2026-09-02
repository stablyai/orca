import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
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
import type { BrowserClientDownloadRoute } from './browser-client-download-relay'
import type { PageInitiatedTabBudget } from './browser-page-initiated-tab-budget'
import type {
  BrowserCertificateFailure,
  BrowserLoadError,
  BrowserSessionUserAgentMode,
  BrowserViewportOverride
} from '../../shared/browser-workspace-types'
import type { BrowserAnnotationViewportBridgeOptions } from '../../shared/browser-annotation-viewport-bridge'
import type { KeybindingOverrides } from '../../shared/keybindings'

export const AUTOMATION_VISIBILITY_ACQUIRE_TIMEOUT_MS = 2_000

export function isChromiumInternalErrorUrl(url: string): boolean {
  return url.startsWith('chrome-error://')
}

export function resolveWithTimeout<T>(
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

export function releaseAutomationVisibilityToken(
  renderer: Electron.WebContents,
  token: string
): void {
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

export function cleanupLateAutomationVisibilityToken(
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

export function createNoopRestoreForTimedOutAutomationAcquire(
  renderer: Electron.WebContents,
  acquirePromise: Promise<unknown>,
  timedOut: boolean
): () => void {
  if (timedOut) {
    cleanupLateAutomationVisibilityToken(renderer, acquirePromise)
  }
  return () => {}
}

export function isAutomationVisibilityToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0
}

export type BrowserGuestRegistration = {
  browserPageId?: string
  browserTabId?: string
  workspaceId?: string
  worktreeId?: string
  sessionProfileId?: string | null
  userAgentMode?: BrowserSessionUserAgentMode
  webContentsId: number
  rendererWebContentsId: number
}

export type PendingPermissionEvent = Omit<BrowserPermissionDeniedEvent, 'browserPageId'>
export type PendingPopupEvent = Omit<BrowserPopupEvent, 'browserPageId'>
export type BrowserDownloadDoneState = 'completed' | 'cancelled' | 'interrupted'
export type PopupOwnerContext = {
  browserTabId: string
  rootGuestWebContentsId: number
}

/**
 * What a guest is allowed to be. A browsing guest is the web — popups, clicked-link routing and
 * anti-detection all apply. A workspace-document guest renders one granted document and gets none
 * of that; `host` is the renderer that minted its grant, and the only sink for what it reports.
 */
export type BrowserGuestPolicy =
  | { profile: 'browsing' }
  | { profile: 'workspace-doc'; host: Electron.WebContents }

export const BROWSING_GUEST_POLICY: BrowserGuestPolicy = { profile: 'browsing' }

export type PendingMainFrameNavigation = {
  currentUrl: string
  supersededUrls: string[]
}

export type AuthUserAgentOverrideOperation = {
  sequence: number
  userAgent: string
}

export type AuthUserAgentOverrideState = {
  confirmed: AuthUserAgentOverrideOperation | null
  nextSequence: number
  pending: AuthUserAgentOverrideOperation[]
}

export const SAFE_POPUP_WINDOW_OPTIONS = {
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

export type ActiveDownload = {
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
  clientRoute: BrowserClientDownloadRoute | null
  remoteDestination: BrowserDownloadFinishedEvent['remoteDestination']
  receivedBytes: number
  transientState: BrowserDownloadProgressEvent['state']
  terminalEvent: BrowserDownloadFinishedEvent | null
  startedSent: boolean
  cleanup: (() => void) | null
}

export function safeOrigin(rawUrl: string): string {
  const external = normalizeExternalBrowserUrl(rawUrl)
  const urlToParse = external ?? rawUrl
  try {
    return new URL(urlToParse).origin
  } catch {
    return external ?? 'unknown'
  }
}

export type BrowserManagerSettings = {
  keybindings?: KeybindingOverrides
  mobileEmulatorEnabled?: boolean
}

export type BrowserManagerLoadError = Pick<
  BrowserLoadError,
  'code' | 'description' | 'validatedUrl'
>

export type BrowserManagerGrabTypes = {
  cancelReason: BrowserGrabCancelReason
  payload: BrowserGrabPayload
  rect: BrowserGrabRect
  result: BrowserGrabResult
  screenshot: BrowserGrabScreenshot
}

export type {
  BrowserAnnotationViewportBridgeOptions,
  BrowserCertificateFailure,
  BrowserLoadError,
  BrowserSessionUserAgentMode,
  BrowserViewportOverride,
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent,
  BrowserClientDownloadRoute,
  BrowserGrabCancelReason,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserGrabResult,
  BrowserGrabScreenshot,
  KeybindingOverrides,
  PageInitiatedTabBudget
}
