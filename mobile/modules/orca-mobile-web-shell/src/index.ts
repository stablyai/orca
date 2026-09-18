import { requireNativeViewManager } from 'expo-modules-core'
import type { ComponentType } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import type { MobileWebShellLoadStatePayload } from './load-state'

export type OrcaMobileWebShellViewProps = ViewProps & {
  /**
   * Absolute path of an activated generation directory: `index.html`, `manifest.json`, and
   * `assets/<sha256>.<ext>`. The TypeScript store owns it and has already verified every byte;
   * the view only reads, and never from a path the page can influence.
   */
  generationDirectory: string
  /** `[A-Za-z0-9_-]{1,128}`. Scopes the private origin, so every mount must mint a fresh one. */
  sessionId: string
  onLoadState?: (event: NativeSyntheticEvent<MobileWebShellLoadStatePayload>) => void
}

/**
 * Renders one generation directory in a WebView served from a private origin. There is no reload
 * and no imperative surface: a retry is a remount under a new React key, which rebuilds the
 * WebView and reinstalls every fence.
 */
export const OrcaMobileWebShellView: ComponentType<OrcaMobileWebShellViewProps> =
  requireNativeViewManager<OrcaMobileWebShellViewProps>('OrcaMobileWebShell')

export {
  MOBILE_WEB_SHELL_FAILURE_REASONS,
  parseMobileWebShellLoadState,
  type MobileWebShellFailureReason,
  type MobileWebShellLoadState,
  type MobileWebShellLoadStatePayload
} from './load-state'
