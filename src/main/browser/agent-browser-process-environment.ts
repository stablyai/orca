import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const AGENT_BROWSER_SOCKET_DIRECTORY_PREFIX = 'orca-ab-'

export function createAgentBrowserProcessEnvironment(options: {
  inheritedEnv: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  userDataPath: string
}): NodeJS.ProcessEnv {
  if (options.platform === 'win32' || options.inheritedEnv.AGENT_BROWSER_SOCKET_DIR?.trim()) {
    return options.inheritedEnv
  }
  const profileKey = createHash('sha256').update(options.userDataPath).digest('hex').slice(0, 16)
  const socketDirectory = join('/tmp', `${AGENT_BROWSER_SOCKET_DIRECTORY_PREFIX}${profileKey}`)
  try {
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
    chmodSync(socketDirectory, 0o700)
  } catch {
    return options.inheritedEnv
  }
  return { ...options.inheritedEnv, AGENT_BROWSER_SOCKET_DIR: socketDirectory }
}
