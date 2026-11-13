import {
  requireNativeModule,
  requireOptionalNativeModule,
  requireNativeViewManager
} from 'expo-modules-core'
import type { ComponentType, RefAttributes } from 'react'
import { Platform, type NativeSyntheticEvent, type ViewProps } from 'react-native'
import type { MobileWebShellLoadStatePayload } from './load-state'

/** One raw JSON envelope, exactly as the page posted it. Parsing is the caller's. */
export type MobileWebShellBridgeMessagePayload = { json: string }

/** The URL of a main-frame navigation the shell cancelled, as the document spelled it. */
export type MobileWebShellExternalNavigationPayload = { url: string }

export type OrcaMobileWebShellViewProps = ViewProps & {
  // Activated generation contains index.html, manifest.json and assets/<sha256>.<ext>; TS store verifies bytes, view only reads paths the page cannot choose.
  generationDirectory: string
  /** `[A-Za-z0-9_-]{1,128}`. Scopes the private origin, so every mount must mint a fresh one. */
  sessionId: string
  // Bridge is off by default with nothing registered. Opt-in on Android below WEB_MESSAGE_LISTENER/Chromium 83 fails isolation-unavailable instead of loading unfenced.
  bridgeEnabled?: boolean
  onLoadState?: (event: NativeSyntheticEvent<MobileWebShellLoadStatePayload>) => void
  // Raw JSON from window.orcaBridge; native silently rejects other origins/frames/WebViews and envelopes above 640 KiB (MobileWebShellBridge.maxMessageByteCount).
  onBridgeMessage?: (event: NativeSyntheticEvent<MobileWebShellBridgeMessagePayload>) => void
  // Offer only gesture-started main-frame navigations/downloads away from shell document; reject own-document taps/downloads, redirects, meta refresh and script navigation.
  // URL is unfiltered (native cap 4096 chars); handler must apply readBridgeExternalLinkUrl before opening so scheme policy can update over the air.
  onExternalNavigation?: (
    event: NativeSyntheticEvent<MobileWebShellExternalNavigationPayload>
  ) => void
  // iOS only: a left-edge swipe fires onBackEdgeSwipe instead of reaching the page. Android has the hardware key.
  backEdgeSwipe?: boolean
  onBackEdgeSwipe?: () => void
}

/** What a ref on the view carries. Expo puts the view's functions on the component prototype. */
export type OrcaMobileWebShellViewHandle = {
  // Post raw JSON; reject over-cap messages or unavailable receivers (no page handshake, navigation, load failure, renderer gone) so host requests cannot silently hang.
  // Resolve does not prove delivery: iOS reports callAsyncJavaScript failures, Android’s void postMessage only proves enqueue. Require a page acknowledgment for delivery.
  postBridgeMessage: (json: string) => Promise<void>
  createVisualDocument: (html: string) => Promise<string>
  releaseVisualDocument: (url: string) => Promise<void>
}

// Render activated generation at private origin; retry by remounting under a new key to reinstall fences. postBridgeMessage cannot report load success.
export const OrcaMobileWebShellView: ComponentType<
  OrcaMobileWebShellViewProps & RefAttributes<OrcaMobileWebShellViewHandle>
> = requireNativeViewManager<
  OrcaMobileWebShellViewProps & RefAttributes<OrcaMobileWebShellViewHandle>
>('OrcaMobileWebShell')

// iOS shows the file:// URI in Quick Look; Android hands the content:// URI to the system PDF viewer with read access.
// Android rejects with code native_pdf_no_viewer when no installed app opens PDFs.
export function presentPdf(uri: string): Promise<void> {
  return requireNativeModule<{ presentPdf: (uri: string) => Promise<void> }>(
    'OrcaMobileWebShell'
  ).presentPdf(uri)
}

type ImageModule = {
  shareImage: (uri: string, mime: string) => Promise<void>
  saveImageToPhotos: (uri: string, mime: string) => Promise<void>
}

// iOS takes a file:// URI; Android takes a FileProvider content:// URI and grants the chosen app read access.
export function shareImage(uri: string, mime: string): Promise<void> {
  return requireNativeModule<ImageModule>('OrcaMobileWebShell').shareImage(uri, mime)
}

// iOS asks for add-only Photos access; Android writes to Pictures/Orca. Rejects with code native_image_permission_denied when refused.
export function saveImageToPhotos(uri: string, mime: string): Promise<void> {
  return requireNativeModule<ImageModule>('OrcaMobileWebShell').saveImageToPhotos(uri, mime)
}

// iOS only: starts WebKit's helper processes ahead of the first page. Later calls are no-ops.
export function warmUpWebShell(): void {
  if (Platform.OS !== 'ios') {
    return
  }
  // A binary built before warmUp existed has the module without the function.
  const shell = requireOptionalNativeModule<{ warmUp?: () => void }>('OrcaMobileWebShell')
  if (typeof shell?.warmUp === 'function') {
    shell.warmUp()
  }
}

export type WebViewProvider = { name: string; version: string; hasShellFeatures: boolean }

// Android only: the WebView provider and whether it has the shell's fences. Null when unknown.
export function currentWebViewProvider(): WebViewProvider | null {
  if (Platform.OS !== 'android') {
    return null
  }
  const shell = requireOptionalNativeModule<{
    currentWebViewProvider?: () => WebViewProvider | null
  }>('OrcaMobileWebShell')
  try {
    return shell?.currentWebViewProvider?.() ?? null
  } catch {
    return null
  }
}

export { supportsVisualDocuments } from './visual-document-capability'

export {
  MOBILE_WEB_SHELL_FAILURE_REASONS,
  parseMobileWebShellLoadState,
  type MobileWebShellFailureReason,
  type MobileWebShellLoadState,
  type MobileWebShellLoadStatePayload
} from './load-state'
