import {
  type BigIntStats,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import { COPIES_TRASH_DIR, SET_ASIDE_ROLLOUTS_DIR } from './codex-account-history-cleanup-manifest'
import {
  hasNoLinkBelowHome,
  isInsideHome,
  lstatOrNull,
  onlyOwnerWrites
} from './codex-account-copy-checks'

// Sync file calls on purpose: this runs on the copies cleanup's own worker thread.

/** How long a moved copy waits before its recheck may delete it: room to undo a bad release. */
export const TRASH_GRACE_MS = 7 * 24 * 60 * 60_000
export const ENTRIES_FILE = 'entries.json'
// Where a copy may be put back: the folders sharing left copies in, never elsewhere in the home.
export const RESTORE_ROOT = new RegExp(
  `^(?:(?:sessions|archived_sessions)(?:\\.\\d+)?\\.orca-profile-merge|${SET_ASIDE_ROLLOUTS_DIR.replaceAll('.', '\\.')})$`
)

/** One moved copy: where it came from, and both files as they were when it was verified. */
export type TrashEntry = {
  name: string
  from: string
  original: string
  copyKey: string
  originalKey: string
  movedAt: number
  /** Bytes a recheck already matched, while both files keep these keys. */
  progress?: { key: string; matched: number }
}

const isEntry = (value: unknown): value is TrashEntry => {
  const entry = value as Partial<TrashEntry> | null
  return (
    !!entry &&
    typeof entry.name === 'string' &&
    typeof entry.from === 'string' &&
    typeof entry.original === 'string' &&
    typeof entry.copyKey === 'string' &&
    typeof entry.originalKey === 'string' &&
    typeof entry.movedAt === 'number'
  )
}

/** Null when the list exists but can't be read: nothing in that trash is moved, restored or deleted. */
export function readEntries(trash: string): TrashEntry[] | null {
  let text: string
  try {
    text = readFileSync(join(trash, ENTRIES_FILE), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const entries = (parsed as { entries?: unknown } | null)?.entries
    return Array.isArray(entries) ? entries.filter(isEntry) : null
  } catch {
    return null
  }
}

export function writeEntries(trash: string, entries: TrashEntry[]): boolean {
  const target = join(trash, ENTRIES_FILE)
  const staged = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(staged, `${JSON.stringify({ version: 1, entries })}\n`)
    renameSync(staged, target)
    return true
  } catch {
    try {
      unlinkSync(staged)
    } catch {
      // Nothing staged.
    }
    return false
  }
}

/** The home's trash folder, made if missing; null unless it is a real folder inside the home. */
export function trashFolder(accountHome: string, create: boolean): string | null {
  const trash = join(accountHome, COPIES_TRASH_DIR)
  if (create && !lstatOrNull(trash)) {
    mkdirSync(trash, { mode: 0o700 })
  }
  const stats = lstatOrNull(trash)
  return stats?.isDirectory() &&
    !stats.isSymbolicLink() &&
    hasNoLinkBelowHome(accountHome, trash) &&
    isInsideHome(accountHome, join(trash, ENTRIES_FILE))
    ? trash
    : null
}

export const homePath = (accountHome: string, path: string): string =>
  relative(accountHome, path).split(/[\\/]/).join('/')

// A copy another user could write or that shares its bytes under another name is never removed.
export function safeToRemove(
  accountHome: string,
  path: string,
  stats: BigIntStats | null
): boolean {
  return (
    !!stats?.isFile() &&
    stats.nlink === 1n &&
    onlyOwnerWrites(stats) &&
    isInsideHome(accountHome, path) &&
    hasNoLinkBelowHome(accountHome, path)
  )
}

export const busyOnWindows = (error: unknown): boolean =>
  process.platform === 'win32' &&
  ['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException | null)?.code ?? '')
