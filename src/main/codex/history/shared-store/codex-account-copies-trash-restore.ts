import { linkSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hasNoLinkBelowHome, isInsideHome, lstatOrNull } from './codex-account-copy-checks'
import { RESTORE_ROOT, type TrashEntry } from './codex-account-copies-trash-entries'

// Sync file calls on purpose: this runs on the copies cleanup's own worker thread.

/** Makes each missing folder of `parts` under the home, one level at a time; false on a link. */
function makeFolders(accountHome: string, parts: string[]): boolean {
  let current = accountHome
  for (const part of parts) {
    current = join(current, part)
    if (!lstatOrNull(current)) {
      mkdirSync(current)
    }
    const stats = lstatSync(current)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return false
    }
  }
  return true
}

/**
 * Puts a copy back where it was, never over another file (a hard link fails on one that exists);
 * false when that place is taken or isn't safely inside the home.
 */
export function restore(accountHome: string, path: string, entry: TrashEntry): boolean {
  const parts = entry.from.split('/')
  if (!RESTORE_ROOT.test(parts[0]) || parts.some((part) => part === '' || part === '..')) {
    return false
  }
  const target = join(accountHome, ...parts)
  const there = lstatOrNull(target)
  const here = lstatOrNull(path)
  // A restore cut short after its link: both names hold the same file.
  if (there && here && there.dev === here.dev && there.ino === here.ino) {
    unlinkSync(path)
    return true
  }
  if (there || !makeFolders(accountHome, parts.slice(0, -1))) {
    return false
  }
  if (!hasNoLinkBelowHome(accountHome, dirname(target)) || !isInsideHome(accountHome, target)) {
    return false
  }
  linkSync(path, target)
  unlinkSync(path)
  return true
}
