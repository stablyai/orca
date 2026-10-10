import { requireNativeViewManager } from 'expo-modules-core'
import type { ComponentType, RefAttributes } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import type { MobileWebShellLoadStatePayload } from './load-state'

/** One raw JSON envelope, exactly as the page posted it. Parsing is the caller's. */
export type MobileWebShellBridgeMessagePayload = { json: string }

/** The URL of a main-frame navigation the shell cancelled, as the document spelled it. */
export type MobileWebShellExternalNavigationPayload = { url: string }

export type OrcaMobileWebShellViewProps = ViewProps & {
  /**
   * Absolute path of an activated generation directory: `index.html`, `manifest.json`, and
   * `assets/<sha256>.<ext>`. The TypeScript store owns it and has already verified every byte;
   * the view only reads, and never from a path the page can influence.
   */
  generationDirectory: string
  /** `[A-Za-z0-9_-]{1,128}`. Scopes the private origin, so every mount must mint a fresh one. */
  sessionId: string
  /**
   * Off unless asked for: with it false nothing is registered on either platform, so the view
   * behaves exactly as it did before the bridge existed. On Android a provider older than
   * `WEB_MESSAGE_LISTENER` (Chromium 88) reports `isolation-unavailable` rather than loading
   * without a channel, and only when this is true.
   */
  bridgeEnabled?: boolean
  onLoadState?: (event: NativeSyntheticEvent<MobileWebShellLoadStatePayload>) => void
  /**
   * The page posted `json` through `window.orcaBridge`. Native has already refused anything from
   * another origin, another frame or another WebView, and anything over the 640 KiB cap
   * (`MobileWebShellBridge.maxMessageByteCount`); a refusal is silent and reaches no event.
   */
  onBridgeMessage?: (event: NativeSyntheticEvent<MobileWebShellBridgeMessagePayload>) => void
  /**
   * A main-frame navigation a human started was cancelled, which is the user aiming the top frame
   * somewhere else: a tap on a link inside the sealed HTML-preview frame, which the browser hands up
   * as a top-frame request.
   *
   * **Only a gesture-started navigation away from the shell's own document is offered.** A top-page
   * meta refresh, a redirect and anything the page does to its own path carry no gesture, so none of
   * them reaches this. Neither does a tap naming the shell's own document: that is refused outright
   * and never offered, because allowing it would reload the page out from under the session and
   * offering it would send the user out of the app -- and that holds for `<a href="/" download>` too,
   * which is the same URL in a download's clothing. A gesture-started download of anything else is
   * offered, which is what makes `<a download>` behave as it does on the native screens.
   *
   * The URL is unfiltered by design — `readBridgeExternalLinkUrl` owns the scheme list and lives in
   * the half that ships over the air — so a handler must run it through that before opening
   * anything. Bounded natively at 4096 characters so an artifact cannot spend the boundary.
   */
  onExternalNavigation?: (
    event: NativeSyntheticEvent<MobileWebShellExternalNavigationPayload>
  ) => void
}

/** What a ref on the view carries. Expo puts the view's functions on the component prototype. */
export type OrcaMobileWebShellViewHandle = {
  /**
   * Delivers one raw JSON envelope to the page. Rejects when the message is over the cap, and when
   * there is nowhere to post: no page has spoken since the last load, a navigation is in flight,
   * the load failed, or the renderer is gone. The caller is the host, so a silent drop is a request
   * that never settles.
   *
   * Delivery is never proven by resolve. iOS rejects the failures it is told about, because
   * `callAsyncJavaScript` reports whether the page ran the delivery; Android cannot, because
   * `JavaScriptReplyProxy.postMessage` is void and has no acknowledgement, so resolve there means
   * enqueued rather than delivered. Anything that must know the page received a message has to
   * hear that from the page.
   */
  postBridgeMessage: (json: string) => Promise<void>
}

/**
 * Renders one generation directory in a WebView served from a private origin. There is no reload:
 * a retry is a remount under a new React key, which rebuilds the WebView and reinstalls every
 * fence. The only imperative call is `postBridgeMessage`, and it can say nothing about the load.
 */
export const OrcaMobileWebShellView: ComponentType<
  OrcaMobileWebShellViewProps & RefAttributes<OrcaMobileWebShellViewHandle>
> = requireNativeViewManager<
  OrcaMobileWebShellViewProps & RefAttributes<OrcaMobileWebShellViewHandle>
>('OrcaMobileWebShell')

export {
  MOBILE_WEB_SHELL_FAILURE_REASONS,
  parseMobileWebShellLoadState,
  type MobileWebShellFailureReason,
  type MobileWebShellLoadState,
  type MobileWebShellLoadStatePayload
} from './load-state'
