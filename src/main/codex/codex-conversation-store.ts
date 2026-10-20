import {
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  type Stats
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

// Why: Codex keeps one conversation's identity in the store, not the file — its
// SQLite row picks the current segment after a revert, fork/archive/delete
// require files under this home's own roots, and writer exclusion is a lock
// file here. Sharing these (plus `sqlite_home`) gives every account one store.
export const CODEX_CONVERSATION_STORE_DIRS = [
  'sessions',
  'archived_sessions',
  'thread-writer-locks'
] as const

// The pre-link tree stays beside the link: Orca never deletes conversation data.
const BEFORE_SHARED_STORE_SUFFIX = '.before-shared-store'

// Present only once a home's conversations live in the shared store and its own
// state was carried over; only then may its config name the shared SQLite home.
export const CODEX_SHARED_STORE_MARKER_FILE = '.orca-shared-store.json'

export function isCodexHomeOnSharedStore(managedHome: string): boolean {
  try {
    const marker: unknown = JSON.parse(
      readFileSync(join(managedHome, CODEX_SHARED_STORE_MARKER_FILE), 'utf8')
    )
    return Boolean(
      marker && typeof marker === 'object' && 'completed' in marker && marker.completed === true
    )
  } catch {
    return false
  }
}

export type CodexStoreLinkOutcome =
  | { kind: 'linked' }
  | { kind: 'deferred'; reason: string }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'failed'; reason: string }

/** True when every store directory of this home is a link that resolves to the store's. */
export function isCodexConversationStoreLinked(managedHome: string, storeHome: string): boolean {
  return CODEX_CONVERSATION_STORE_DIRS.every((name) => {
    const entry = join(managedHome, name)
    try {
      return (
        lstatSync(entry).isSymbolicLink() &&
        realpathSync(entry) === realpathSync(join(storeHome, name))
      )
    } catch {
      return false
    }
  })
}

/**
 * Links a managed home's conversation store to the store home. A real tree is
 * merged in first without overwriting anything; a genuine conflict leaves this
 * home on its own store and reports the paths. Callers run this only while no
 * Orca-launched Codex is live in the home.
 */
export function linkCodexConversationStore(
  managedHome: string,
  storeHome: string
): CodexStoreLinkOutcome {
  if (sameDirectory(managedHome, storeHome)) {
    return { kind: 'linked' }
  }
  const conflicts: string[] = []
  for (const name of CODEX_CONVERSATION_STORE_DIRS) {
    const target = join(storeHome, name)
    const entry = join(managedHome, name)
    try {
      mkdirSync(target, { recursive: true })
      const stat = lstatOrNull(entry)
      if (stat?.isSymbolicLink()) {
        if (realpathSync(entry) === realpathSync(target)) {
          continue
        }
        return { kind: 'failed', reason: `${entry} links to ${readlinkSync(entry)}, not the store` }
      }
      if (stat?.isDirectory() && name !== 'thread-writer-locks') {
        conflicts.push(...mergeTreeInto(entry, target))
      }
    } catch (error) {
      return { kind: 'deferred', reason: errorText(error) }
    }
  }
  if (conflicts.length > 0) {
    return { kind: 'conflict', paths: conflicts }
  }
  for (const name of CODEX_CONVERSATION_STORE_DIRS) {
    const entry = join(managedHome, name)
    const stat = lstatOrNull(entry)
    if (stat?.isSymbolicLink()) {
      continue
    }
    try {
      const aside = stat ? uniqueAsidePath(entry) : null
      if (aside) {
        // Windows refuses this while a process holds a file in the tree; the next launch retries.
        renameSync(entry, aside)
      }
      symlinkSync(join(storeHome, name), entry, process.platform === 'win32' ? 'junction' : 'dir')
      if (aside && name !== 'thread-writer-locks') {
        // A live Codex may have started a file between the merge and the rename.
        mergeTreeInto(aside, join(storeHome, name))
      }
    } catch (error) {
      return { kind: 'deferred', reason: errorText(error) }
    }
  }
  return { kind: 'linked' }
}

/** Puts every file of `source` into `target` at the same relative path; returns conflicts. */
function mergeTreeInto(source: string, target: string): string[] {
  const conflicts: string[] = []
  const pending = [source]
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const from = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(from)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      const to = join(target, relative(source, from))
      if (!placeFile(from, to)) {
        conflicts.push(from)
      }
    }
  }
  return conflicts
}

function placeFile(from: string, to: string): boolean {
  const existing = lstatOrNull(to)
  if (!existing) {
    mkdirSync(dirname(to), { recursive: true })
    try {
      linkSync(from, to)
    } catch {
      copyFileSync(from, to)
    }
    return true
  }
  const source = lstatSync(from)
  if (existing.dev === source.dev && existing.ino === source.ino) {
    return true
  }
  // Rollouts only grow by appending: a copy that extends the other is the same file, later.
  const fromBytes = readFileSync(from)
  const toBytes = readFileSync(to)
  if (toBytes.length >= fromBytes.length) {
    return toBytes.subarray(0, fromBytes.length).equals(fromBytes)
  }
  if (!fromBytes.subarray(0, toBytes.length).equals(toBytes)) {
    return false
  }
  const staged = `${to}.orca-merge`
  copyFileSync(from, staged)
  renameSync(staged, to)
  return true
}

function uniqueAsidePath(entry: string): string {
  let candidate = `${entry}${BEFORE_SHARED_STORE_SUFFIX}`
  for (let index = 2; lstatOrNull(candidate); index += 1) {
    candidate = `${entry}${BEFORE_SHARED_STORE_SUFFIX}-${index}`
  }
  return candidate
}

function sameDirectory(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
