import { lstatSync } from 'node:fs'
import { join } from 'node:path'

// agent-browser's own session-name rule; doubles as a traversal fence for the `join` below.
const SAFE_SESSION_NAME = /^[A-Za-z0-9_-]+$/

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
