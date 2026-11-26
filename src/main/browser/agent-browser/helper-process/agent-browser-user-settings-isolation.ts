/**
 * Orca owns its helpers' launch and target, so a user's AGENT_BROWSER_* settings (headed,
 * autoConnect, extensions, pinTab...) must not reach them. Windows env keys ignore case.
 * Callers also point AGENT_BROWSER_CONFIG at an Orca file so the user's config files are skipped.
 */
export function isolateFromUserAgentBrowserSettings(
  inheritedEnv: NodeJS.ProcessEnv,
  keepKeys: readonly string[]
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(inheritedEnv).filter(([key]) => {
      const upper = key.toUpperCase()
      return !upper.startsWith('AGENT_BROWSER_') || keepKeys.includes(upper)
    })
  )
}
