/**
 * Switch for isolated (`<webview>`) plugin frames. Main-process only: plugins can neither read nor
 * write it. Off keeps today's srcdoc iframe (no user-gesture methods are offered); on, a guest
 * that cannot be set up fails closed.
 */

/** Off until the flip PR: flipping (or rolling back) the feature is this one line. */
export const PLUGIN_ISOLATED_FRAMES_DEFAULT = false

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
