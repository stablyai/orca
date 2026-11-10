// Checks a restore runs before it writes anything. Each one refuses (or narrows the restore) where
// writing would lose a file nothing else has a copy of.

import { constants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CheckpointRepo,
  diffTrees,
  isSafeRelativePath,
  type TreeChange,
  WorktreeCheckpointError
} from './worktree-checkpoint-git'
import type { WorktreeCheckpoint } from './worktree-checkpoint-snapshot'

export async function assertNoConflicts(repo: CheckpointRepo): Promise<void> {
  const unmerged = await repo.git(['ls-files', '-u', '-z'])
  if (unmerged.length > 0) {
    throw new WorktreeCheckpointError(
      'merge-conflicts',
      'The worktree has unresolved merge conflicts; resolve or abort them first.'
    )
  }
}

/** Entries git keeps off the disk (sparse checkout, skip-worktree) or doesn't look at
 *  (assume-unchanged). A snapshot holds their index version, not the file, so restore leaves them. */
export async function hiddenIndexPaths(repo: CheckpointRepo): Promise<Set<string>> {
  const out = await repo.git(['ls-files', '-v', '-z'])
  const hidden = new Set<string>()
  for (const entry of out.split('\0')) {
    const tag = entry.charAt(0)
    if (entry.length > 2 && (tag === 'S' || (tag >= 'a' && tag <= 'z'))) {
      hidden.add(entry.slice(2))
    }
  }
  return hidden
}

export async function restoreChanges(
  repo: CheckpointRepo,
  fromTree: string,
  toTree: string,
  hidden: Set<string>
): Promise<TreeChange[]> {
  return (await diffTrees(repo, fromTree, toTree)).filter((change) => !hidden.has(change.path))
}

/** Paths the checkpoint writes that exist on disk but not in the working tree's snapshot (ignored,
 *  or too large to snapshot): the undo checkpoint must hold them before they are overwritten. */
export function overwrittenUnsnapshottedPaths(repo: CheckpointRepo, target: WorktreeCheckpoint) {
  return async (tree: string): Promise<string[]> => {
    const added = (await diffTrees(repo, tree, target.tree)).filter((c) => c.status === 'A')
    const present: string[] = []
    for (const change of added) {
      const absolute = join(repo.root, change.path)
      // An unreadable file can't be saved; assertWritable refuses to overwrite it instead.
      const stat = isSafeRelativePath(change.path) ? await lstat(absolute).catch(() => null) : null
      if (
        stat &&
        (stat.isSymbolicLink() ||
          (await access(absolute, constants.R_OK).then(
            () => true,
            () => false
          )))
      ) {
        present.push(change.path)
      }
    }
    return present
  }
}

/** Refuses before any write when a path to write is a folder or an unreadable file now, when a
 *  leading folder of it is now a file the restore doesn't delete itself (an ignored file would be
 *  replaced with no copy), or when any path is unsafe. */
export async function assertWritable(repo: CheckpointRepo, changes: TreeChange[]): Promise<void> {
  const unsafe = changes.filter((change) => !isSafeRelativePath(change.path))
  if (unsafe.length > 0) {
    throw new WorktreeCheckpointError(
      'unsafe-path',
      'The checkpoint names paths outside the worktree.',
      unsafe.map((change) => change.path)
    )
  }
  const deleted = new Set(changes.filter((c) => c.status === 'D').map((c) => c.path))
  const folders = new Map<string, boolean>()
  const isNonFolder = async (path: string): Promise<boolean> => {
    let known = folders.get(path)
    if (known === undefined) {
      const stat = await lstat(join(repo.root, path)).catch(() => null)
      known = stat !== null && !stat.isDirectory()
      folders.set(path, known)
    }
    return known
  }
  const blocked: string[] = []
  for (const change of changes) {
    if (change.status === 'D') {
      continue
    }
    const absolute = join(repo.root, change.path)
    const stat = await lstat(absolute).catch(() => null)
    const unreadable =
      stat?.isFile() === true &&
      (await access(absolute, constants.R_OK).then(
        () => false,
        () => true
      ))
    const parts = change.path.split('/')
    let leadingFile = false
    for (let depth = 1; depth < parts.length && !leadingFile; depth += 1) {
      const prefix = parts.slice(0, depth).join('/')
      leadingFile = !deleted.has(prefix) && (await isNonFolder(prefix))
    }
    if (stat?.isDirectory() || unreadable || leadingFile) {
      blocked.push(change.path)
    }
  }
  if (blocked.length > 0) {
    throw new WorktreeCheckpointError(
      'blocked-path',
      'Something now sits where the checkpoint writes a file.',
      blocked
    )
  }
}
