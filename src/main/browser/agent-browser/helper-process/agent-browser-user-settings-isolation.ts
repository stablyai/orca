/**
 * Orca owns its helpers' launch and target, so a user's AGENT_BROWSER_* env and config files
 * (headed, autoConnect, extensions, pinTab...) must not reach them. Windows env keys ignore case.
 */
export function isolateFromUserAgentBrowserSettings(options: {
  inheritedEnv: NodeJS.ProcessEnv
  keepKeys: readonly string[]
  configPath: string | null
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(options.inheritedEnv).filter(([key]) => {
      const upper = key.toUpperCase()
      return !upper.startsWith('AGENT_BROWSER_') || options.keepKeys.includes(upper)
    })
  )
  if (options.configPath) {
    // An explicit config skips ~/.agent-browser/config.json and ./agent-browser.json.
    env.AGENT_BROWSER_CONFIG = options.configPath
  }
  return env
}
