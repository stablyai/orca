import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/file-access/absolute-dir-override'

export function copilotHomeDir(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  return resolveAbsoluteDirOverride(env.COPILOT_HOME, join(homeDir, '.copilot'))
}

// A Copilot session id is also its directory name under session-state; never let it carry a path.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** The events file for a session, or null when the id cannot name a directory. */
export function copilotEventsPath(store: string, sessionId: string): string | null {
  const id = sessionId.trim()
  return SESSION_ID.test(id) ? join(store, id, 'events.jsonl') : null
}
