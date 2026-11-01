import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core'
import type { ComponentType, RefAttributes } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
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
  // Bridge is off by default with nothing registered. Opt-in on Android below WEB_MESSAGE_LISTENER/Chromium 88 fails isolation-unavailable instead of loading unfenced.
  bridgeEnabled?: boolean
  onLoadState?: (event: NativeSyntheticEvent<MobileWebShellLoadStatePayload>) => void
  // Raw JSON from window.orcaBridge; native silently rejects other origins/frames/WebViews and envelopes above 640 KiB (MobileWebShellBridge.maxMessageByteCount).
  onBridgeMessage?: (event: NativeSyntheticEvent<MobileWebShellBridgeMessagePayload>) => void
  // Offer only gesture-started main-frame navigations/downloads away from shell document; reject own-document taps/downloads, redirects, meta refresh and script navigation.
  // URL is unfiltered (native cap 4096 chars); handler must apply readBridgeExternalLinkUrl before opening so scheme policy can update over the air.
  onExternalNavigation?: (
    event: NativeSyntheticEvent<MobileWebShellExternalNavigationPayload>
  ) => void
}

/** What a ref on the view carries. Expo puts the view's functions on the component prototype. */
export type OrcaMobileWebShellViewHandle = {
  // Post raw JSON; reject over-cap messages or unavailable receivers (no page handshake, navigation, load failure, renderer gone) so host requests cannot silently hang.
  // Resolve does not prove delivery: iOS reports callAsyncJavaScript failures, Android’s void postMessage only proves enqueue. Require a page acknowledgment for delivery.
  postBridgeMessage: (json: string) => Promise<void>
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

// iOS only; Android backups are off and older binaries lack the call, so both skip it.
export async function excludeFromBackup(path: string): Promise<void> {
  const shell = requireNativeModule<{ excludeFromBackup?: (path: string) => Promise<void> }>(
    'OrcaMobileWebShell'
  )
  await shell.excludeFromBackup?.(path)
}

export {
  MOBILE_WEB_SHELL_FAILURE_REASONS,
  parseMobileWebShellLoadState,
  type MobileWebShellFailureReason,
  type MobileWebShellLoadState,
  type MobileWebShellLoadStatePayload
} from './load-state'
