/**
 * Switch for isolated (`<webview>`) plugin frames. Main-process only: plugins can neither read nor
 * write it. Off keeps today's srcdoc iframe (declarative panels show they are unavailable, and no
 * user-gesture methods are offered); on, a guest that cannot be set up fails closed.
 */

/** Rolling the feature back is this one line. */
export const PLUGIN_ISOLATED_FRAMES_DEFAULT = true

export const PLUGIN_ISOLATED_FRAMES_ENV = 'ORCA_PLUGIN_ISOLATED_FRAMES'

export function isPluginFrameIsolationEnabled(
  settings: { experimentalPluginIsolatedFrames?: boolean } | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const override = env[PLUGIN_ISOLATED_FRAMES_ENV]
  if (override === '0') {
    return false
  }
  if (override === '1') {
    return true
  }
  return settings?.experimentalPluginIsolatedFrames ?? PLUGIN_ISOLATED_FRAMES_DEFAULT
}
