import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isolateFromUserAgentBrowserSettings } from './agent-browser-user-settings-isolation'

const AGENT_BROWSER_SOCKET_DIRECTORY_PREFIX = 'orca-ab-'

/** Per-tab daemon expiry survives Orca crashes and exceeds the bridge command timeout. */
export const AGENT_BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1000

export type AgentBrowserProcessEnvironment = {
  env: NodeJS.ProcessEnv
  /** Only an Orca-derived directory proves sessions belong to this profile; inherited paths may be shared. */
  ownsSocketDirectory: boolean
}

export function createAgentBrowserProcessEnvironment(options: {
  inheritedEnv: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  userDataPath: string
}): AgentBrowserProcessEnvironment {
  // Commands get Orca's tokened proxy URL per spawn; a user's autoConnect, pinTab or extensions
  // would refuse it or open tabs behind Orca's tab model.
  // A namespace moves sockets under namespaces/<name>/, where session reset and exit waits don't look.
  const env = isolateFromUserAgentBrowserSettings(options.inheritedEnv, [
    'AGENT_BROWSER_SOCKET_DIR'
  ])
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS =
    options.inheritedEnv.AGENT_BROWSER_IDLE_TIMEOUT_MS?.trim() ||
    String(AGENT_BROWSER_IDLE_TIMEOUT_MS)
  // Its auto-accept dropped alert text; Orca keeps every dialog open until someone answers it.
  env.AGENT_BROWSER_NO_AUTO_DIALOG = '1'
  if (options.platform === 'win32' || env.AGENT_BROWSER_SOCKET_DIR?.trim()) {
    return { env, ownsSocketDirectory: false }
  }
  const profileKey = createHash('sha256').update(options.userDataPath).digest('hex').slice(0, 16)
  const socketDirectory = join('/tmp', `${AGENT_BROWSER_SOCKET_DIRECTORY_PREFIX}${profileKey}`)
  try {
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
    chmodSync(socketDirectory, 0o700)
  } catch {
    return { env, ownsSocketDirectory: false }
  }
  env.AGENT_BROWSER_SOCKET_DIR = socketDirectory
  return { env, ownsSocketDirectory: true }
}

/** Until this lands, agent-browser reads the user's config files; a missing file would fail every command. */
export async function pointAtEmptyAgentBrowserConfig(
  env: NodeJS.ProcessEnv,
  userDataPath: string
): Promise<void> {
  const path = join(userDataPath, 'agent-browser-config.json')
  await writeFile(path, '{}\n', { mode: 0o600 })
  // An explicit config skips ~/.agent-browser/config.json and ./agent-browser.json.
  env.AGENT_BROWSER_CONFIG = path
}
