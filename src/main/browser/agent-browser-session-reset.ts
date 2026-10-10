import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// agent-browser's own session-name rule; doubles as a traversal fence for the `join` below.
const SAFE_SESSION_NAME = /^[A-Za-z0-9_-]+$/
const SESSION_EXIT_POLL_MS = 25

/** Mirrors agent-browser's `get_socket_dir()`, where every daemon keeps its `<session>.pid`. */
export function resolveAgentBrowserSocketDirectory(env: NodeJS.ProcessEnv): string {
  if (env.AGENT_BROWSER_SOCKET_DIR) {
    return env.AGENT_BROWSER_SOCKET_DIR
  }
  if (env.XDG_RUNTIME_DIR) {
    return join(env.XDG_RUNTIME_DIR, 'agent-browser')
  }
  return join(homedir(), '.agent-browser')
}

/**
 * True once the daemon that answered `close` for `sessionName` has exited, false at `deadline`.
 *
 * Why: closing an idle name spawns a daemon (and its own browser) that lingers for its shutdown
 * delay, and agent-browser >= 0.27.2 reuses any live socket without its old 150 ms settle sleep,
 * so a command sent meanwhile would run against that daemon's browser instead of Orca's page.
 */
export async function waitForAgentBrowserSessionExit(options: {
  env: NodeJS.ProcessEnv
  sessionName: string
  deadline: number
}): Promise<boolean> {
  if (!SAFE_SESSION_NAME.test(options.sessionName)) {
    return true
  }
  let pidPath: string
  try {
    pidPath = join(resolveAgentBrowserSocketDirectory(options.env), `${options.sessionName}.pid`)
  } catch {
    // No resolvable socket directory leaves nothing to wait on, as before this check existed.
    return true
  }
  while (existsSync(pidPath)) {
    if (Date.now() >= options.deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_EXIT_POLL_MS))
  }
  return true
}

/**
 * True when no daemon can be holding `sessionName`, so closing it would only start one.
 *
 * Only an Orca-derived socket directory proves that (`ownsSocketDirectory`): it is a
 * private per-profile `/tmp` directory, never an inherited one shared with a second
 * profile, and never Windows, which uses named pipes and leaves no socket to inspect.
 */
export function canSkipAgentBrowserSessionReset(options: {
  ownsSocketDirectory: boolean
  socketDirectory: string | undefined
  sessionName: string
}): boolean {
  const { socketDirectory, sessionName } = options
  if (!options.ownsSocketDirectory || !socketDirectory || !SAFE_SESSION_NAME.test(sessionName)) {
    return false
  }
  try {
    lstatSync(join(socketDirectory, `${sessionName}.sock`))
    return false
  } catch (error) {
    // Only a proven-absent socket is safe to skip; permission and other failures prove nothing.
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}
