// Drain legacy trash left by interrupted background deletion; current releases create none.

import { lstat, readdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { removeHostTree } from './host-tree-removal'
import { isFolderRepo } from '../shared/repo-kind'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Repo } from '../shared/repo-types'
import { parseWslPath } from './wsl'
import { getRepoRoutingConnectionId } from '../shared/execution-host'

export const WORKTREE_TRASH_DIR_NAME = '.orca-worktree-trash'

// Only names produced by the retired rename scheme qualify for cleanup.
const TRASH_ENTRY_PATTERN = /^wt-\d+-[0-9a-f]{8}$/

const TRASH_SWEEP_MAX_CONTAINERS = 200

/** Delete only legacy generated entries inside known trash roots. */
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
      if (!TRASH_ENTRY_PATTERN.test(entry)) {
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
    await rmdir(trashRoot).catch(() => {})
  }
  if (removed > 0) {
    console.log(`[worktrees] Swept ${removed} leftover worktree director(ies) from a previous run`)
  }
  return { removed }
}

/** Trash roots are beside worktrees: flat at the root, or one level down for nested layout. */
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

/** Workspace roots of local git repos — the only places Orca ever created worktree trash. */
export function collectWorktreeTrashSweepRoots(
  repos: readonly Repo[],
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'>
): string[] {
  const roots = new Set<string>()
  for (const repo of repos) {
    if (getRepoRoutingConnectionId(repo) || isFolderRepo(repo) || parseWslPath(repo.path)) {
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
