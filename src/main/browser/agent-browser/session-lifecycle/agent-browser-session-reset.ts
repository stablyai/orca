import { lstatSync } from 'node:fs'
import { join } from 'node:path'

// Match agent-browser session names and reject path traversal.
const SAFE_SESSION_NAME = /^[A-Za-z0-9_-]+$/

/** Skip daemon-starting resets only when this profile's owned Unix socket is provably absent. */
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

const DAEMON_EXIT_WAIT_MS = 1_000
const DAEMON_EXIT_POLL_MS = 25

/** agent-browser answers `close`, then exits and removes its socket ~100 ms later; a command sent meanwhile reaches the dying daemon. */
export async function waitForAgentBrowserSessionExit(options: {
  ownsSocketDirectory: boolean
  socketDirectory: string | undefined
  sessionName: string
}): Promise<void> {
  if (!options.ownsSocketDirectory) {
    return
  }
  const deadline = Date.now() + DAEMON_EXIT_WAIT_MS
  while (!canSkipAgentBrowserSessionReset(options) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DAEMON_EXIT_POLL_MS))
  }
}
