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
