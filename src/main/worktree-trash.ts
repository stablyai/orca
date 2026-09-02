// Why: `git worktree remove` deletes the whole checkout (usually a multi-GB node_modules) inside the
// remove IPC, so the UI sat on a spinner for 8-35s. Renaming the directory into a sibling trash root
// is a metadata operation, and the recursive delete then runs after the IPC has already returned.

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { removeHostTree } from './host-tree-removal'
import { isFolderRepo } from '../shared/repo-kind'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Repo } from '../shared/repo-types'
import { parseWslPath } from './wsl'

export const WORKTREE_TRASH_DIR_NAME = '.orca-worktree-trash'

// `<epoch-ms>-<nonce>`: the nonce keeps concurrent removals of same-named worktrees from colliding.
const TRASH_ENTRY_PATTERN = /^wt-\d+-[0-9a-f]{8}$/

// Why: the sweep must stay cheap on a workspace root holding many repo containers.
const TRASH_SWEEP_MAX_CONTAINERS = 200

/** Trash root for a worktree: a hidden sibling, so the rename always stays on one volume. */
export function getWorktreeTrashRoot(worktreePath: string): string {
  return join(dirname(worktreePath), WORKTREE_TRASH_DIR_NAME)
}

export function isWorktreeTrashEntryName(entryName: string): boolean {
  return TRASH_ENTRY_PATTERN.test(entryName)
}

/**
 * Move a worktree directory aside so the caller can return before it is deleted.
 * Returns the trash path, or `undefined` when the rename is unavailable (a different
 * volume, or Windows open handles) and the caller must delete in place instead.
 */
export async function moveWorktreeDirectoryToTrash(
  worktreePath: string
): Promise<string | undefined> {
  const trashRoot = getWorktreeTrashRoot(worktreePath)
  const trashPath = join(trashRoot, `wt-${Date.now()}-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(trashRoot, { recursive: true })
    const trashRootStat = await lstat(trashRoot)
    if (!trashRootStat.isDirectory() || trashRootStat.isSymbolicLink()) {
      throw new Error(`Refusing non-directory worktree trash root: ${trashRoot}`)
    }
    await rename(worktreePath, trashPath)
    return trashPath
  } catch (error) {
    console.warn(
      `[worktrees] Deferred deletion unavailable for ${worktreePath}; deleting in place`,
      error
    )
    // Leave no empty trash root behind when the rename never happened; rmdir keeps queued entries.
    await rmdir(trashRoot).catch(() => {})
    return undefined
  }
}

/** Undo a trash rename so a failed registration cleanup leaves the worktree exactly as it was. */
export async function restoreWorktreeDirectoryFromTrash(
  trashPath: string,
  worktreePath: string
): Promise<boolean> {
  try {
    await rename(trashPath, worktreePath)
    return true
  } catch (error) {
    console.warn(`[worktrees] Failed to restore ${worktreePath} from ${trashPath}`, error)
    return false
  }
}

// Why serialized: one background delete at a time keeps a burst of removals from saturating disk I/O
// while the user keeps working.
let queuedTrashDeletions: Promise<void> = Promise.resolve()

export function scheduleWorktreeTrashDeletion(trashPath: string): void {
  queuedTrashDeletions = queuedTrashDeletions.then(async () => {
    try {
      await removeHostTree(trashPath)
    } catch (error) {
      // Why only a warning: the directory is already invisible to the user, and the startup sweep retries it.
      console.warn(`[worktrees] Failed to delete trashed worktree at ${trashPath}`, error)
    }
  })
}

/** Test/shutdown hook: resolves once every queued background deletion has settled. */
export function whenWorktreeTrashDeletionsSettled(): Promise<void> {
  return queuedTrashDeletions
}

/**
 * Delete trash entries left behind by a previous run (a crash or a kill during background deletion).
 * Only entries matching the generated name pattern inside a trash root are removed.
 */
export async function sweepStaleWorktreeTrash(
  workspaceRoots: readonly string[]
): Promise<{ removed: number }> {
  let removed = 0
  for (const trashRoot of await collectExistingTrashRoots(workspaceRoots)) {
    let entries: string[]
    try {
      const trashRootStat = await lstat(trashRoot)
      if (!trashRootStat.isDirectory() || trashRootStat.isSymbolicLink()) {
        continue
      }
      entries = await readdir(trashRoot)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!isWorktreeTrashEntryName(entry)) {
        continue
      }
      try {
        await removeHostTree(join(trashRoot, entry))
        removed += 1
      } catch (error) {
        console.warn(
          `[worktrees] Failed to sweep leftover worktree at ${trashRoot}/${entry}`,
          error
        )
      }
    }
  }
  if (removed > 0) {
    console.log(`[worktrees] Swept ${removed} leftover worktree director(ies) from a previous run`)
  }
  return { removed }
}

/** Trash roots live beside worktrees, so they sit at the workspace root (flat) or one level in (nested). */
async function collectExistingTrashRoots(workspaceRoots: readonly string[]): Promise<string[]> {
  const trashRoots = new Set<string>()
  for (const workspaceRoot of new Set(workspaceRoots)) {
    trashRoots.add(join(workspaceRoot, WORKTREE_TRASH_DIR_NAME))
    let containers: string[] = []
    try {
      containers = (await readdir(workspaceRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== WORKTREE_TRASH_DIR_NAME)
        .slice(0, TRASH_SWEEP_MAX_CONTAINERS)
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const container of containers) {
      trashRoots.add(join(workspaceRoot, container, WORKTREE_TRASH_DIR_NAME))
    }
  }
  return [...trashRoots]
}

/** Workspace roots of local git repos — the only places Orca creates worktree trash. */
export function collectWorktreeTrashSweepRoots(
  repos: readonly Repo[],
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'>
): string[] {
  const roots = new Set<string>()
  for (const repo of repos) {
    if (repo.connectionId || isFolderRepo(repo) || parseWslPath(repo.path)) {
      continue
    }
    try {
      const workspaceRoot = computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, settings))
      if (!parseWslPath(workspaceRoot)) {
        roots.add(workspaceRoot)
      }
    } catch {
      // A repo with an unusable configured base path simply has no trash root to sweep.
    }
  }
  return [...roots]
}
