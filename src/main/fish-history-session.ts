import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * Per-worktree fish history.
 *
 * fish ignores HISTFILE entirely — history lives at `<data dir>/<name>_history`
 * where `<name>` comes only from the `fish_history` variable, and there is no
 * custom-directory knob. So the session NAME is the only isolation lever, and
 * the file necessarily lands in the user's fish data dir rather than inside
 * Orca's history tree. That is why deletion needs its own path here instead of
 * riding the tree tombstone the way bash/zsh history does.
 *
 * `XDG_DATA_HOME` is deliberately not redirected: that would move every other
 * tool's data for the session, not just fish's history.
 */
const SESSION_PREFIX = 'orca_'
const RELAY_SESSION_PREFIX = 'orca_relay_'
const SAFE_SESSION_NAME = /^orca_(?:relay_)?[0-9a-f]{1,64}$/
/** Deliberately does NOT match the relay prefix. A relay host keyed by its
 *  CLIENT's worktree ids shares the one fish data dir with any desktop Orca on
 *  the same machine, whose live set knows nothing of those ids — so an
 *  attributable name is the only thing keeping that sweep off remote history.
 *  Relay files are removed by exact name when their worktree goes away. */
const ORCA_HISTORY_FILE = /^orca_([0-9a-f]{1,64})_history$/

export function isSafeFishHistorySession(session: unknown): session is string {
  return typeof session === 'string' && SAFE_SESSION_NAME.test(session)
}

/** Drop a `fish_history` this process inherited from an outer Orca.
 *  fish EXPORTS the variable, so an Orca launched from a fish pane hands the
 *  LAUNCHING worktree's session name to every pane of the nested app, which then
 *  writes into that worktree's history file (STA-4682). Only Orca-minted names
 *  match, so a user's own `fish_history` survives; desktop and relay drop each
 *  other's names deliberately, since neither owns the other's worktree ids. */
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

/** The directory fish will write history into, for a given environment.
 *  Resolve this from the PTY's SPAWN env: Orca can be launched with a different
 *  `XDG_DATA_HOME`/`HOME` than the shells it spawns, and fish follows its own. */
export function resolveFishHistoryDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim()
  const dataHome =
    xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), '.local', 'share')
  return join(dataHome, 'fish')
}

/** Removes one history file, refusing anything that is not a regular file.
 *  Why lstat: a symlink here would take `rmSync` out of the fish data dir. */
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

/** Delete one worktree's fish history file, trying every directory it could be in.
 *  Callers pass the directory recorded at spawn time plus this process's own, since
 *  the two disagree whenever Orca's environment differs from the PTY's. */
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

/**
 * Delete every Orca-minted fish history file whose worktree is gone.
 *
 * Why a sweep and not just per-worktree deletion: the history file outlives the
 * directory that names it. A crash between tombstone and removal, a hand-deleted
 * history dir, or a file written by an older build all orphan one, and only a
 * scan of the data dir can find those. Matching on Orca's own `orca_<hex>_`
 * prefix means the user's real `fish_history` is never a candidate.
 *
 * `minAgeMs` mirrors the age guard the history-tree GC already applies: the
 * live-worktree set is a snapshot, so a worktree created between the snapshot
 * and this sweep would otherwise look dead and lose the history it is actively
 * writing. A live session's file keeps a recent mtime, so this doubles as a
 * second check on the set itself.
 *
 * Refuses to run at all on an empty live set: that cannot be told apart from a
 * store that failed to hydrate, and unlike the tree GC this deletes files
 * outside Orca's own directory.
 */
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
