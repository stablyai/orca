import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserError } from '../../browser-error'

// Match agent-browser session names and reject path traversal.
const SAFE_SESSION_NAME = /^[A-Za-z0-9_-]+$/

/** Skip daemon-starting resets only when this profile's owned Unix socket is provably absent. */
export function canSkipAgentBrowserSessionReset(options: {
  ownsSocketDirectory: boolean
  socketDirectory: string | undefined
  sessionName: string
}): boolean {
  return options.ownsSocketDirectory && isSessionSocketAbsent(options)
}

function isSessionSocketAbsent(options: {
  socketDirectory: string | undefined
  sessionName: string
}): boolean {
  const { socketDirectory, sessionName } = options
  if (!socketDirectory || !SAFE_SESSION_NAME.test(sessionName)) {
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
  if (
    process.platform === 'win32' ||
    !options.socketDirectory ||
    !SAFE_SESSION_NAME.test(options.sessionName)
  ) {
    return
  }
  const deadline = Date.now() + DAEMON_EXIT_WAIT_MS
  while (!isSessionSocketAbsent(options)) {
    if (Date.now() >= deadline) {
      throw new BrowserError(
        'browser_owner_unavailable',
        `Helper session ${options.sessionName} has not exited; retry after agent-browser exits`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, DAEMON_EXIT_POLL_MS))
  }
}
