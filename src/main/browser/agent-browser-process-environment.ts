import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const AGENT_BROWSER_SOCKET_DIRECTORY_PREFIX = 'orca-ab-'

/**
 * Lifetime bound for the agent-browser daemon.
 *
 * `agent-browser` is a client/daemon CLI: Orca only ever spawns the short-lived
 * client, which forks a daemon Orca holds no handle on and that reparents to
 * pid 1 immediately. Nothing in Orca can reap it — not teardown, not a pid walk
 * (see `windows-pty-job.ts` for why walking your own orphans is guesswork) —
 * and a SIGKILL'd Orca never runs teardown at all. The daemon's own idle timer
 * is the only bound that survives every way Orca can die (#16367).
 *
 * 10 minutes: >6x `EXEC_TIMEOUT_MS` (90s) so no command, retry chain, or normal
 * gap between two user commands can be cut short by it, while capping an
 * abandoned daemon at minutes instead of days. Only per-tab helper daemons get
 * this: see `externalChromiumAgentBrowserEnvironment` for why the daemon that
 * owns a whole Chromium tree must not be idled out.
 */
export const AGENT_BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1000

export type AgentBrowserProcessEnvironment = {
  env: NodeJS.ProcessEnv
  /**
   * True only when Orca derived the socket directory itself. An inherited
   * `AGENT_BROWSER_SOCKET_DIR` can be shared with another Orca profile, so it is
   * no proof that `session list` under it sees only this profile's daemons.
   */
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
