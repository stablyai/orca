// Both pick the socket directory, so dropping either loses a running helper and its live tabs.
const SOCKET_LOCATION_KEYS = new Set(['AGENT_BROWSER_SOCKET_DIR', 'AGENT_BROWSER_NAMESPACE'])

/**
 * Orca owns its helpers' launch and target, so a user's AGENT_BROWSER_* env and config files
 * (headed, autoConnect, extensions, pinTab...) must not reach them. Windows env keys ignore case.
 */
export function isolateFromUserAgentBrowserSettings(
  inheritedEnv: NodeJS.ProcessEnv,
  configPath: string | null
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(inheritedEnv).filter(([key]) => {
      const upper = key.toUpperCase()
      return !upper.startsWith('AGENT_BROWSER_') || SOCKET_LOCATION_KEYS.has(upper)
    })
  )
  if (configPath) {
    // An explicit config skips ~/.agent-browser/config.json and ./agent-browser.json.
    env.AGENT_BROWSER_CONFIG = configPath
  }
  return env
}
