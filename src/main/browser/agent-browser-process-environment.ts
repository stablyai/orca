import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
  const env = { ...options.inheritedEnv }
  if (!env.AGENT_BROWSER_IDLE_TIMEOUT_MS?.trim()) {
    env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(AGENT_BROWSER_IDLE_TIMEOUT_MS)
  }
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
