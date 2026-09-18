import { requireNativeViewManager } from 'expo-modules-core'
import type { ComponentType, RefAttributes } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import type { MobileWebShellLoadStatePayload } from './load-state'

/** One raw JSON envelope, exactly as the page posted it. Parsing is the caller's. */
export type MobileWebShellBridgeMessagePayload = { json: string }

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
}

/** What a ref on the view carries. Expo puts the view's functions on the component prototype. */
export type OrcaMobileWebShellViewHandle = {
  /**
   * Delivers one raw JSON envelope to the page. Rejects when no bridge is installed and when the
   * message is over the cap, rather than dropping it, because the caller is the host and a silent
   * drop is a request that never settles.
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
