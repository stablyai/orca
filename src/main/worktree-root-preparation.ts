import { mkdir } from 'node:fs/promises'
import type { GlobalSettings, Repo } from '../shared/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { forEachWithConcurrency } from '../shared/map-with-concurrency'
import { isFolderRepo } from '../shared/repo-kind'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'

type WorktreeRootPreparationSettings = Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'>
type WorktreeRootPreparationStore = {
  getSettings: () => WorktreeRootPreparationSettings
  getRepos: () => Repo[]
}

export const LOCAL_WORKTREE_ROOT_PREPARATION_CONCURRENCY = 8

export async function prepareLocalWorktreeRootForRepo(
  store: Pick<WorktreeRootPreparationStore, 'getSettings'>,
  repo: Repo
): Promise<void> {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || isFolderRepo(repo)) {
    return
  }

  try {
    const root = computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, store.getSettings()))
    // Why: mkdir touches the current root to preflight macOS TCC, while
    // access remains scoped by recomputed settings instead of a permanent grant.
    await mkdir(root, { recursive: true })
  } catch (error) {
    console.warn(`[worktree-root] failed to prepare worktree root for ${repo.path}:`, error)
  }
}

export async function prepareLocalWorktreeRootsForRepos(
  store: WorktreeRootPreparationStore
): Promise<void> {
  await forEachWithConcurrency(
    store.getRepos(),
    LOCAL_WORKTREE_ROOT_PREPARATION_CONCURRENCY,
    (repo) => prepareLocalWorktreeRootForRepo(store, repo)
  )
}
