// Puts the working tree back to a checkpoint. Before anything is written, every file the restore
// would change or delete is saved in an "undo" checkpoint (ignored files it would overwrite too),
// so the restore itself can always be undone. HEAD and the branch never move: commits made after
// the checkpoint stay on the branch. The staged state comes back only while HEAD is unchanged.

import { realpath, rm, rmdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import {
  type CheckpointRepo,
  resolveCommit,
  type TreeChange,
  withTempIndex,
  WorktreeCheckpointError
} from './worktree-checkpoint-git'
import {
  assertNoConflicts,
  assertUndoCovers,
  assertWritable,
  hiddenIndexPaths,
  overwrittenUnsnapshottedPaths,
  restoreChanges
} from './worktree-checkpoint-restore-guards'
import {
  captureWorktreeTree,
  type WorktreeCheckpoint,
  writeWorktreeCheckpoint
} from './worktree-checkpoint-snapshot'

export type WorktreeRestorePreview = {
  /** Files that differ between the working tree now and the checkpoint. */
  changes: TreeChange[]
  /** HEAD moved since the checkpoint (for example the agent committed); those commits stay. */
  headMoved: boolean
}

export type WorktreeRestoreResult = WorktreeRestorePreview & {
  /** The checkpoint of the working tree as it was just before this restore. */
  undo: WorktreeCheckpoint
  indexRestored: boolean
}

export async function previewWorktreeRestore(
  repo: CheckpointRepo,
  target: WorktreeCheckpoint
): Promise<WorktreeRestorePreview> {
  const now = await captureWorktreeTree(repo)
  return {
    changes: await restoreChanges(repo, now.tree, target.tree, await hiddenIndexPaths(repo)),
    headMoved: now.head !== target.head
  }
}

/** Deletes a file the checkpoint doesn't have, refusing to follow a symlinked parent folder. */
async function removeWorktreeFile(rootReal: string, root: string, path: string): Promise<void> {
  const absolute = join(root, path)
  const parentReal = await realpath(dirname(absolute)).catch(() => null)
  if (!parentReal) {
    return
  }
  const fromRoot = relative(rootReal, parentReal)
  if (fromRoot.startsWith('..') || fromRoot.startsWith(sep)) {
    throw new WorktreeCheckpointError('unsafe-path', `${path} resolves outside the worktree.`, [
      path
    ])
  }
  await rm(absolute, { force: true })
  // Drop folders the deletion left empty, never the root and never a folder with anything left.
  let folder = dirname(absolute)
  while (folder.length > root.length && folder.startsWith(root)) {
    try {
      await rmdir(folder)
    } catch {
      break
    }
    folder = dirname(folder)
  }
}

async function restoreIndexEntries(
  repo: CheckpointRepo,
  fromTree: string,
  toTree: string,
  hidden: Set<string>
): Promise<void> {
  if (fromTree === toTree) {
    return
  }
  const out = await repo.git(['diff-tree', '-r', '-z', '--no-renames', '--raw', fromTree, toTree])
  const fields = out.split('\0')
  const records: string[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]
    if (!header.startsWith(':')) {
      continue
    }
    const [, newMode, , newObject] = header.slice(1).split(' ')
    const path = fields[index + 1]
    // Rewriting an entry drops its skip-worktree/assume-unchanged bit; those stay as they are.
    if (path === undefined || hidden.has(path)) {
      continue
    }
    // A path the staged tree lacks arrives as mode 000000 with an all-zero id: --index-info removes it.
    records.push(`${newMode === '000000' ? '0' : newMode} ${newObject}\t${path}`)
  }
  if (records.length > 0) {
    await repo.git(['update-index', '-z', '--index-info'], {
      stdin: `${records.join('\0')}\0`
    })
  }
}

async function applyChanges(
  repo: CheckpointRepo,
  target: WorktreeCheckpoint,
  changes: TreeChange[]
): Promise<void> {
  const rootReal = await realpath(repo.root)
  // Deletes first, so a file can take the place of a folder (or a case-only rename) it replaces.
  for (const change of changes) {
    if (change.status === 'D') {
      await removeWorktreeFile(rootReal, repo.root, change.path)
    }
  }
  const writes = changes.filter((change) => change.status !== 'D').map((change) => change.path)
  if (writes.length > 0) {
    await withTempIndex(repo, false, async (env) => {
      await repo.git(['read-tree', target.tree], { env })
      // checkout-index refuses symlinked leading paths itself; -f replaces what is there.
      await repo.git(['checkout-index', '-f', '-z', '--stdin'], {
        env,
        stdin: `${writes.join('\0')}\0`
      })
    })
  }
}

export async function restoreWorktreeCheckpoint(
  repo: CheckpointRepo,
  target: WorktreeCheckpoint,
  undo: { ref: string; labels?: Record<string, string>; now: number }
): Promise<WorktreeRestoreResult> {
  await assertNoConflicts(repo)
  const hidden = await hiddenIndexPaths(repo)
  // Saving the undo point first is what makes the restore safe: a failure below leaves it to restore.
  const before = await captureWorktreeTree(repo, {
    forceInclude: overwrittenUnsnapshottedPaths(repo, target)
  })
  const changes = await restoreChanges(repo, before.tree, target.tree, hidden)
  await assertWritable(repo, changes)
  await assertUndoCovers(repo, before.tree, changes)
  const undoCheckpoint = await writeWorktreeCheckpoint(repo, undo.ref, before, {
    kind: 'undo',
    createdAt: undo.now,
    ...(undo.labels ? { labels: undo.labels } : {})
  })
  try {
    await applyChanges(repo, target, changes)
  } catch (error) {
    throw new WorktreeCheckpointError(
      'partial',
      `Some files were not restored: ${error instanceof Error ? error.message : String(error)}`,
      [],
      undoCheckpoint.ref
    )
  }
  const head = await resolveCommit(repo, 'HEAD')
  const headMoved = head !== target.head
  let indexRestored = false
  if (!headMoved && target.indexTree && before.indexTree) {
    // Same commit as at the checkpoint: put back exactly what was staged then. Only entries that
    // differ are rewritten, so the rest keep their stat data and the next status stays fast. Files
    // are already restored, so a busy index (another git holding index.lock) only loses staging.
    try {
      await restoreIndexEntries(repo, before.indexTree, target.indexTree, hidden)
      indexRestored = true
    } catch {
      indexRestored = false
    }
  }
  return { changes, headMoved, undo: undoCheckpoint, indexRestored }
}
