import { mkdir } from 'node:fs/promises'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Repo } from '../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import { computeWorkspaceRootAsync, getWorktreePathSettings } from './ipc/worktree-logic'
import { getWorktreeMirrorDistro } from './project-runtime-git-options'
import type { ProjectRuntimeResolutionStore } from './local-project-runtime-resolution'

// `localWindowsRuntimeDefault` is listed because the mirror distro is resolved
// from it plus the project catalog: a store that omits it prepares a different
// root than the create path uses.
type WorktreeRootPreparationSettings = Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'> &
  Partial<Pick<GlobalSettings, 'localWindowsRuntimeDefault'>>
type WorktreeRootPreparationStore = {
  getSettings: () => WorktreeRootPreparationSettings
  getRepos: () => Repo[]
  getProjects?: ProjectRuntimeResolutionStore['getProjects']
}

export async function prepareLocalWorktreeRootForRepo(
  store: Pick<WorktreeRootPreparationStore, 'getSettings' | 'getProjects'>,
  repo: Repo
): Promise<void> {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || isFolderRepo(repo)) {
    return
  }

  try {
    const root = await computeWorkspaceRootAsync(
      repo.path,
      getWorktreePathSettings(repo, store.getSettings(), getWorktreeMirrorDistro(store, repo))
    )
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
  await Promise.all(store.getRepos().map((repo) => prepareLocalWorktreeRootForRepo(store, repo)))
}
