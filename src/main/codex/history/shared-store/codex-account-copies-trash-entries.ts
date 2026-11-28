import { randomBytes } from 'node:crypto'
import {
  type BigIntStats,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
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
// One list per moved batch, named for its move time: a launch reads only the lists that are due,
// and rewrites only the ones it changed, so bookkeeping grows with the copies, never their square.
const LIST_FILE = /^list-([0-9a-z]+)-[0-9a-f]+\.json$/
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
  /** The copy's full key just after its move (a rename changes ctime); missing, it goes back. */
  movedKey?: string
  /** Bytes a recheck already matched, while both files keep these keys. */
  progress?: { key: string; matched: number }
  /** Both files' keys when a recheck last passed; unchanged, the next launch skips the read. */
  passed?: string
}

const STRING_FIELDS = ['name', 'from', 'original', 'copyKey', 'originalKey'] as const

function isEntry(value: unknown): value is TrashEntry {
  if (typeof value !== 'object' || value === null || !('movedAt' in value)) {
    return false
  }
  const fields: Record<string, unknown> = { ...value }
  return (
    typeof value.movedAt === 'number' &&
    (fields.movedKey === undefined || typeof fields.movedKey === 'string') &&
    STRING_FIELDS.every((field) => typeof fields[field] === 'string')
  )
}

export const newListName = (now: number): string =>
  `list-${now.toString(36)}-${randomBytes(4).toString('hex')}.json`

/** The trash's lists, each with the time its batch was moved. */
export function listFiles(trash: string): { name: string; movedAt: number }[] {
  return readdirSync(trash).flatMap((name) => {
    const match = LIST_FILE.exec(name)
    return match ? [{ name, movedAt: Number.parseInt(match[1], 36) }] : []
  })
}

/** Null when the list can't be read: nothing it names is restored or deleted. */
export function readList(trash: string, list: string): TrashEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(trash, list), 'utf8'))
    const entries =
      typeof parsed === 'object' && parsed !== null && 'entries' in parsed ? parsed.entries : null
    return Array.isArray(entries) ? entries.filter(isEntry) : null
  } catch {
    return null
  }
}

/** Writes a list whole (staged, then renamed), or removes it once it names nothing. */
export function writeList(trash: string, list: string, entries: TrashEntry[]): boolean {
  const target = join(trash, list)
  if (entries.length === 0) {
    try {
      unlinkSync(target)
      return true
    } catch {
      return false
    }
  }
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
    isInsideHome(accountHome, join(trash, 'list'))
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
  process.platform === 'win32' && ['EBUSY', 'EPERM', 'EACCES'].includes(errnoCodeOrUnknown(error))
