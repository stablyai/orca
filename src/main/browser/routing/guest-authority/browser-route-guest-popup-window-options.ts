import type { Session, WebContents } from 'electron'
import type { ObservedBrowserGuestGesture } from '../../guest-lifecycle/input/browser-guest-input-gesture'
import type { NewBrowserTabPopupRequest } from '../../guest-lifecycle/popups/browser-popup-new-tab-intent'
import type { PopupChildWindowOptions } from '../../guest-lifecycle/popups/presentation/browser-popup-window-contract'
import type { PopupViewerTarget } from '../../guest-lifecycle/popups/browser-viewer-popup-publication'

export type BrowserRouteGuestPopupWindow = {
  contentWebContents: WebContents
  close: () => void
  onClosed: (listener: () => void) => void
}

export type BrowserRouteGuestPopupDependencies = {
  getPartitionForSession: (session: Session) => string | null
  /** Route guests replace the manager's popup handler, so a denial is otherwise entirely silent. */
  reportBlockedPopup?: (input: { openerWebContentsId: number; url: string }) => void
  popupReleased?: (opener: WebContents) => void
  /** The manager's new-tab policy; true when it answered the request. */
  openNewTabPopup?: (
    source: WebContents,
    request: NewBrowserTabPopupRequest,
    observed: ObservedBrowserGuestGesture | null,
    childOpener?: Electron.WebFrameMain | null
  ) => boolean
  /** A person's own input in a popup takes its opener's page back from the agent. */
  releaseAgentLead?: (openerWebContentsId: number) => void
  isAgentCommandShownHere?: (webContentsId: number) => boolean
  /** Injected input reaching this popup now is a paired viewer's, not an agent's. */
  isPersonCommandRunning?: (webContentsId: number) => boolean
  resolvePopupViewerTarget?: (
    openerWebContentsId: number,
    observed?: ObservedBrowserGuestGesture | null
  ) => PopupViewerTarget
  popupOpened?: (
    opener: WebContents,
    popupContents: WebContents,
    viewerTarget?: PopupViewerTarget
  ) => void
  openPopupWindow?: (
    options: PopupChildWindowOptions,
    targetUrl: string,
    prepareContent: (contents: WebContents) => boolean
  ) => BrowserRouteGuestPopupWindow
}

export type BrowserRouteGuestPopupController = {
  windowOpenHandler: (details?: BrowserRoutePopupRequest) => Electron.WindowOpenHandlerResponse
  closeAll: () => void
  dispose: () => void
}

export type BrowserRoutePopupRequest = {
  url?: string
  referrer?: Electron.Referrer
  postBody?: Electron.PostBody | null
  disposition?: string
  features?: string
  frameName?: string
}

// Allow OAuth sizing without deceptive or inescapable native chrome.
export const ROUTE_POPUP_WINDOW_OPTIONS = {
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
  webPreferences: {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    nodeIntegration: false,
    // Sandboxed and without Node, this only runs the session's preloads (the passkey watch) in iframes.
    nodeIntegrationInSubFrames: true,
    sandbox: true,
    webviewTag: false
  }
} satisfies Electron.BrowserWindowConstructorOptions
