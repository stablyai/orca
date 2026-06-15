import { mkdir } from 'fs/promises'
import type { Store } from './persistence'
import type { Repo } from '../shared/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import { authorizeExternalPath } from './ipc/filesystem-auth'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'

export async function prepareLocalWorktreeRootForRepo(store: Store, repo: Repo): Promise<void> {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || isFolderRepo(repo)) {
    return
  }

  try {
    const root = computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, store.getSettings()))
    await mkdir(root, { recursive: true })
    // Why: worktree roots often live outside the repo. Touch and trust the
    // parent once during repo setup instead of discovering it per worktree.
    authorizeExternalPath(root)
  } catch (error) {
    console.warn(`[worktree-root] failed to prepare worktree root for ${repo.path}:`, error)
  }
}

export async function prepareLocalWorktreeRootsForRepos(store: Store): Promise<void> {
  await Promise.all(store.getRepos().map((repo) => prepareLocalWorktreeRootForRepo(store, repo)))
}
