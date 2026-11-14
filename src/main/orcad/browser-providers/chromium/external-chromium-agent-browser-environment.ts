import { isolateFromUserAgentBrowserSettings } from '../../../browser/agent-browser/helper-process/agent-browser-user-settings-isolation'

// Both pick the socket directory, so dropping either loses a running helper and its live tabs.
const SOCKET_LOCATION_KEYS = ['AGENT_BROWSER_SOCKET_DIR', 'AGENT_BROWSER_NAMESPACE']

// No idle timeout: this daemon owns the user’s remote Chromium and all its live tabs.
// agent-browser 0.33+ reads an unset timeout as one hour, so only "0" keeps it unbounded.
export function externalChromiumAgentBrowserEnvironment(options: {
  inheritedEnv: NodeJS.ProcessEnv
  executablePath: string
  profilePath: string
  sessionName: string
  configPath: string
  browserArgs?: readonly string[]
}): NodeJS.ProcessEnv {
  return {
    ...isolateFromUserAgentBrowserSettings({
      inheritedEnv: options.inheritedEnv,
      keepKeys: SOCKET_LOCATION_KEYS,
      configPath: options.configPath
    }),
    AGENT_BROWSER_IDLE_TIMEOUT_MS:
      options.inheritedEnv.AGENT_BROWSER_IDLE_TIMEOUT_MS?.trim() || '0',
    AGENT_BROWSER_EXECUTABLE_PATH: options.executablePath,
    AGENT_BROWSER_PROFILE: options.profilePath,
    AGENT_BROWSER_SESSION: options.sessionName,
    AGENT_BROWSER_ARGS: options.browserArgs?.join('\n') ?? ''
  }
}
