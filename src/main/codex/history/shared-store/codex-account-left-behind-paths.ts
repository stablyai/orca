import type { BigIntStats } from 'node:fs'
import { readdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MERGE_PENDING_SUFFIX, lstatIfPresent } from '../../../filesystem/merged-directory-link'
import {
  PRE_SHARE_DATABASES_DIR,
  ROLLOUT_FOLDERS,
  SET_ASIDE_ROLLOUTS_DIR,
  factsOf,
  fromManifestPath,
  type FileFacts
} from './codex-account-history-cleanup-manifest'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'

// Codex rebuilds its paginated history from the rollouts, and logs are only logs. The state database
// also holds rows no rollout has (projects, legacy memories), so it stays with memories, goals and
// queues.
const REBUILDABLE_DATABASE_FILE = /^(?:logs|thread_history)_\d+\.sqlite(?:-wal|-shm)?$/

// The space a name frees, as its apparent size: only its last link frees anything.
export function freedBy(stats: BigIntStats): number {
  return stats.nlink > 1n ? 0 : Number(stats.size)
}

// A database goes with its WAL and shared memory or not at all; a file of it appearing since the
// manifest was written means something opened it again.
export function databaseGroup(path: string): string {
  return path.replace(/-(?:wal|shm)$/, '')
}

// Manifest paths are relative to the home and stay inside the folders the cleanup owns.
export function isLeftBehindPath(path: string, kind: 'rollout' | 'database'): boolean {
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:]/.test(part))) {
    return false
  }
  if (kind === 'database') {
    return (
      REBUILDABLE_DATABASE_FILE.test(parts.at(-1)!) &&
      (parts.length === 1 || parts[0] === PRE_SHARE_DATABASES_DIR)
    )
  }
  const folder =
    parts[0] === SET_ASIDE_ROLLOUTS_DIR
      ? parts[1]
      : parts[0].endsWith(MERGE_PENDING_SUFFIX)
        ? parts[0].slice(0, -MERGE_PENDING_SUFFIX.length).replace(/\.\d+$/, '')
        : undefined
  return (
    // `<set-aside dir>/<folder>/…/<file>`, or `<folder>.orca-profile-merge/…/<file>`.
    parts.length >= (parts[0] === SET_ASIDE_ROLLOUTS_DIR ? 3 : 2) &&
    folder !== undefined &&
    ROLLOUT_FOLDERS.has(folder) &&
    parseCodexRolloutThreadId(parts.at(-1)!) !== null
  )
}

// A linked folder on the way would point the delete outside the home.
export async function hasRealFolders(root: string, path: string): Promise<boolean> {
  const parts = path.split('/')
  for (let depth = 1; depth < parts.length; depth += 1) {
    const folder = await lstatIfPresent(join(root, ...parts.slice(0, depth)))
    if (!folder?.isDirectory()) {
      return false
    }
  }
  return true
}

/** The home's file at `path` as it is now, or null when it isn't a plain file reached that way. */
export async function currentLeftBehindFile(
  home: string,
  path: string
): Promise<{ stats: BigIntStats; facts: FileFacts } | null> {
  if (!(await hasRealFolders(home, path))) {
    return null
  }
  const stats = await lstatIfPresent(fromManifestPath(home, path))
  return stats?.isFile()
    ? { stats, facts: factsOf(home, fromManifestPath(home, path), stats) }
    : null
}

export async function removeEmptyFolders(folder: string, shouldStop: () => boolean): Promise<void> {
  // Never through a link that replaced a folder since it was listed.
  if (!(await lstatIfPresent(folder).catch(() => null))?.isDirectory()) {
    return
  }
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (shouldStop()) {
      return
    }
    if (entry.isDirectory()) {
      await removeEmptyFolders(join(folder, entry.name), shouldStop)
    }
  }
  await rmdir(folder).catch(() => {})
}
