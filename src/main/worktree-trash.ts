// Why: releases before worktree removal ran inline renamed checkouts into a sibling trash root and
// deleted them in the background; a quit mid-delete left entries behind. Nothing creates trash now,
// so this sweep only drains those legacy entries.

import { lstat, readdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { removeHostTree } from './host-tree-removal'
import { isFolderRepo } from '../shared/repo-kind'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Repo } from '../shared/repo-types'
import { parseWslPath } from './wsl'
import { whenLocalWorktreeCreatesSettle } from './git/local-worktree-create-activity'

export const WORKTREE_TRASH_DIR_NAME = '.orca-worktree-trash'

// `<epoch-ms>-<nonce>`: the only names the retired rename ever generated.
const TRASH_ENTRY_PATTERN = /^wt-\d+-[0-9a-f]{8}$/

// Why: the sweep must stay cheap on a workspace root holding many repo containers.
const TRASH_SWEEP_MAX_CONTAINERS = 200

/** Delete legacy trash entries. Only entries matching the generated name pattern inside a trash root are removed. */
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
        await whenLocalWorktreeCreatesSettle()
        await removeHostTree(join(trashRoot, entry))
        removed += 1
      } catch (error) {
        console.warn(
          `[worktrees] Failed to sweep leftover worktree at ${trashRoot}/${entry}`,
          error
        )
      }
    }
    // Why: nothing refills the root, so drop it once empty; rmdir keeps anything still inside.
    await rmdir(trashRoot).catch(() => {})
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

/** Workspace roots of local git repos — the only places Orca ever created worktree trash. */
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
