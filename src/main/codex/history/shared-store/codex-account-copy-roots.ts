import { type BigIntStats, readFileSync, readdirSync } from 'node:fs'
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

export function* rolloutFiles(folder: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return
    }
    throw error
  }
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      yield* rolloutFiles(path)
    } else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) {
      yield path
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
