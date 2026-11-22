import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// Fish ignores HISTFILE; isolate with fish_history names in its own data directory.
// Redirecting XDG_DATA_HOME would also move every other tool’s data.
const SESSION_PREFIX = 'orca_'
const RELAY_SESSION_PREFIX = 'orca_relay_'
const SAFE_SESSION_NAME = /^orca_(?:relay_)?[0-9a-f]{1,64}$/
/** Exclude relay names: desktop live-workspace sets do not describe remote clients’ history. */
const ORCA_HISTORY_FILE = /^orca_([0-9a-f]{1,64})_history$/

export function isSafeFishHistorySession(session: unknown): session is string {
  return typeof session === 'string' && SAFE_SESSION_NAME.test(session)
}

/** Clear inherited Orca session names so nested apps cannot write into the launching workspace’s history. */
export function dropInheritedOrcaFishHistory(env: Record<string, string | undefined>): void {
  if (isSafeFishHistorySession(env.fish_history)) {
    delete env.fish_history
  }
}

export function fishHistorySessionName(worktreeHash: string): string {
  return `${SESSION_PREFIX}${worktreeHash}`
}

/** Relay-owned counterpart, namespaced out of the desktop sweep's reach. */
export function relayFishHistorySessionName(worktreeHash: string): string {
  return `${RELAY_SESSION_PREFIX}${worktreeHash}`
}

/** Use the PTY spawn environment; its HOME/XDG_DATA_HOME may differ from Orca’s. */
export function resolveFishHistoryDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim()
  const dataHome =
    xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), '.local', 'share')
  return join(dataHome, 'fish')
}

function removeHistoryFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) {
      return false
    }
    rmSync(path)
    return true
  } catch {
    return false
  }
}

/** Check both spawn-time and current history directories when their environments differ. */
export function deleteFishHistoryFile(session: string, dirs: Iterable<string>): boolean {
  if (!isSafeFishHistorySession(session)) {
    return false
  }
  let removed = false
  for (const dir of new Set(dirs)) {
    removed = removeHistoryFile(join(dir, `${session}_history`)) || removed
  }
  return removed
}

/** Age guards protect post-snapshot workspaces; an empty live set may mean failed hydration. */
export function sweepOrphanedFishHistoryFiles(
  liveWorktreeHashes: ReadonlySet<string>,
  dirs: Iterable<string>,
  minAgeMs = 0,
  now = Date.now()
): number {
  if (liveWorktreeHashes.size === 0) {
    return 0
  }
  let removed = 0
  for (const dir of new Set(dirs)) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const hash = ORCA_HISTORY_FILE.exec(entry)?.[1]
      if (!hash || liveWorktreeHashes.has(hash)) {
        continue
      }
      const path = join(dir, entry)
      if (minAgeMs > 0 && !isOlderThan(path, minAgeMs, now)) {
        continue
      }
      if (removeHistoryFile(path)) {
        removed += 1
      }
    }
  }
  return removed
}

/** Treats an unreadable file as too young: never delete on a failed stat. */
function isOlderThan(path: string, minAgeMs: number, now: number): boolean {
  try {
    return now - lstatSync(path).mtimeMs >= minAgeMs
  } catch {
    return false
  }
}
