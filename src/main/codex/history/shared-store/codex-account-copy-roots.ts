import { type BigIntStats, type Dirent, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { MERGE_PENDING_SUFFIX } from '../../../filesystem/merged-directory-link'
import {
  HISTORY_CLEANUP_MANIFEST,
  SET_ASIDE_ROLLOUTS_DIR
} from './codex-account-history-cleanup-manifest'
import { rolloutTwinPath } from '../rollouts/codex-rollout-compressed-twin'
import { lstatOrNull, removeEmptyFolders } from './codex-account-copy-checks'

// Sync file calls on purpose: this runs on the copies cleanup's own worker thread.

const HISTORY_FOLDERS = ['sessions', 'archived_sessions']
// `sessions.orca-profile-merge`, or `sessions.<ms>.orca-profile-merge` when sharing was toggled.
const MERGE_FOLDER = new RegExp(
  `^(${HISTORY_FOLDERS.join('|')})(?:\\.\\d+)?${MERGE_PENDING_SUFFIX.replaceAll('.', '\\.')}$`
)
const ROLLOUT_FILE = /^rollout-.*\.jsonl(?:\.zst)?$/

// The share streak's start: sharing turned off and on again can leave new conflict copies.
export function sharedSince(accountHome: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(accountHome, HISTORY_CLEANUP_MANIFEST), 'utf8')
    )
    return parsed &&
      typeof parsed === 'object' &&
      'firstSharedAt' in parsed &&
      typeof parsed.firstSharedAt === 'string'
      ? parsed.firstSharedAt
      : null
  } catch {
    return null
  }
}

function realDirectory(path: string): boolean {
  const stats = lstatOrNull(path)
  // Never a link: a junction or symlink here is not Orca's copy.
  return stats !== null && stats.isDirectory() && !stats.isSymbolicLink()
}

export type CopyRoot = { root: string; storeFolder: string; twinOnly: boolean }

/** Where sharing left the home's own forms of rollouts that ~/.codex already had. */
export function listCopyRoots(accountHome: string, storeHome: string): CopyRoot[] {
  const roots: CopyRoot[] = []
  for (const entry of readdirSync(accountHome, { withFileTypes: true })) {
    const match = entry.isDirectory() ? MERGE_FOLDER.exec(entry.name) : null
    if (match) {
      roots.push({
        root: join(accountHome, entry.name),
        storeFolder: join(storeHome, match[1]),
        twinOnly: false
      })
    }
  }
  for (const name of realDirectory(join(accountHome, SET_ASIDE_ROLLOUTS_DIR))
    ? HISTORY_FOLDERS
    : []) {
    roots.push({
      root: join(accountHome, SET_ASIDE_ROLLOUTS_DIR, name),
      storeFolder: join(storeHome, name),
      twinOnly: true
    })
  }
  return roots.filter((root) => realDirectory(root.root))
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Orders home-relative paths the way the walk visits them: folder by folder, names sorted. */
export function compareWalkPaths(a: string[], b: string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = byName(a[index], b[index])
    if (order !== 0) {
      return order
    }
  }
  return a.length - b.length
}

export type WalkedCopy = { root: CopyRoot; copy: string; segments: string[] }
/**
 * `at`: set when the deadline stopped the walk, where the next launch resumes (home-relative).
 * `errors`: folders that couldn't be listed and were skipped.
 */
export type WalkStop = { at?: string; errors: number }

/**
 * Rollouts under `folder` in walk order, lazily; with `after`, only those past it, skipping whole
 * folders that sort before it unread.
 */
function* sortedRolloutFiles(
  root: CopyRoot,
  folder: string,
  segments: string[],
  after: string[] | null,
  listed: Map<string, Dirent[]>,
  deadline: number,
  stop: WalkStop
): Generator<WalkedCopy> {
  // Checked before each listing too: a tree of folders with no rollouts mustn't outrun it.
  // Everything before this folder was walked, so the next launch resumes inside it; on the
  // cursor's own path, nothing past the cursor was reached yet, so the cursor stays.
  if (stop.at !== undefined || Date.now() > deadline) {
    stop.at ??= (after ?? segments).join('/')
    return
  }
  let entries = listed.get(folder)
  try {
    entries ??= readdirSync(folder, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name))
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      // Skipped this launch, not the whole walk: counted, so the home isn't settled.
      stop.errors += 1
    }
    return
  }
  // A folder on the cursor's path is listed again when the walk wraps round: kept, not reread.
  if (after) {
    listed.set(folder, entries)
  }
  for (const entry of entries) {
    const next = [...segments, entry.name]
    let from = after
    if (after) {
      const order = compareWalkPaths(next, after.slice(0, next.length))
      // Before the cursor, or the cursor itself (visited last launch): skipped.
      if (order < 0 || (order === 0 && !entry.isDirectory())) {
        continue
      }
      from = order > 0 ? null : after
    }
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      yield* sortedRolloutFiles(root, path, next, from, listed, deadline, stop)
    } else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) {
      yield { root, copy: path, segments: next }
    }
  }
}

/**
 * The home's copies in walk order, starting just past `after` (a home-relative path the last
 * launch stopped at) and wrapping round, so a launch its deadline cuts short resumes there.
 */
export function* walkCopies(
  accountHome: string,
  storeHome: string,
  after: string | undefined,
  deadline = Infinity,
  stop: WalkStop = { errors: 0 }
): Generator<WalkedCopy> {
  const cursor = after ? after.split('/') : null
  const listed = new Map<string, Dirent[]>()
  const roots = listCopyRoots(accountHome, storeHome)
    .map((root) => ({ root, segments: relative(accountHome, root.root).split(/[\\/]/) }))
    .sort((a, b) => compareWalkPaths(a.segments, b.segments))
  for (const { root, segments } of roots) {
    const order = cursor ? compareWalkPaths(segments, cursor.slice(0, segments.length)) : 1
    if (order >= 0) {
      yield* sortedRolloutFiles(
        root,
        root.root,
        segments,
        order === 0 ? cursor : null,
        listed,
        deadline,
        stop
      )
    }
  }
  if (!cursor) {
    return
  }
  for (const { root, segments } of roots) {
    for (const item of sortedRolloutFiles(
      root,
      root.root,
      segments,
      null,
      listed,
      deadline,
      stop
    )) {
      if (compareWalkPaths(item.segments, cursor) > 0) {
        return
      }
      yield item
    }
  }
}

// The same name in ~/.codex, else its other form (Codex compressed it since).
export function findOriginal(
  root: CopyRoot,
  copy: string
): { path: string; stats: BigIntStats } | null | 'error' {
  const sameName = join(root.storeFolder, relative(root.root, copy))
  const candidates = root.twinOnly
    ? [rolloutTwinPath(sameName)]
    : [sameName, rolloutTwinPath(sameName)]
  for (const path of candidates) {
    const stats = lstatOrNull(path)
    if (stats?.isFile()) {
      return { path, stats }
    }
    if (stats) {
      return 'error'
    }
  }
  return null
}

/** Folders the moves emptied go; anything else in them stays. */
export function removeEmptiedCopyFolders(accountHome: string, storeHome: string): void {
  for (const root of listCopyRoots(accountHome, storeHome)) {
    removeEmptyFolders(root.root)
  }
  const setAside = join(accountHome, SET_ASIDE_ROLLOUTS_DIR)
  if (realDirectory(setAside)) {
    removeEmptyFolders(setAside)
  }
}
