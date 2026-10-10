import type { Store } from '../persistence'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { isFolderRepo } from '../../shared/repo-kind'
import { isWslUncPath } from '../../shared/wsl-paths'
import type { WorkspaceCleanupStrayDirectorySkipReason } from '../../shared/workspace-cleanup-stray-directories'
import { getWorktreeMirrorDistro } from '../project-runtime-git-options'
import { computeWorkspaceRoot, getWorktreePathSettings } from './worktree-logic'

/** One worktree root Orca creates checkouts in, and the projects that share it. */
export type WorkspaceCleanupStrayRoot = {
  path: string
  layout: 'flat' | 'nested'
  repoIds: string[]
  /** Nested layout only: project folder name under the root, mapped to its repo ids. */
  containers: Map<string, string[]>
}

export type WorkspaceCleanupStrayRootPlan = {
  roots: WorkspaceCleanupStrayRoot[]
  skipped: Map<WorkspaceCleanupStrayDirectorySkipReason, number>
  /** Every local project checkout; a project is never a stray folder. */
  projectPaths: string[]
}

/** The store reads a stray-folder scan needs; narrow so tests pass a plain object. */
export type WorkspaceCleanupStrayStore = Pick<Store, 'getRepos' | 'getSettings'> &
  Parameters<typeof getWorktreeMirrorDistro>[0]

/**
 * Resolves the local worktree roots with the same resolver worktree creation uses.
 *
 * Remote and WSL roots are skipped, not read: their files live on another host, and resolving a
 * WSL mirror home spawns `wsl.exe`. A root that also holds a project checkout (a `..` base, or
 * projects created inside the workspace folder) is skipped too, because its other entries are the
 * user's own folders rather than leftovers of Orca's.
 */
export function planWorkspaceCleanupStrayRoots(
  store: WorkspaceCleanupStrayStore
): WorkspaceCleanupStrayRootPlan {
  const settings = store.getSettings()
  const skipped = new Map<WorkspaceCleanupStrayDirectorySkipReason, number>()
  const skip = (reason: WorkspaceCleanupStrayDirectorySkipReason): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
  }
  const rootsByKey = new Map<string, WorkspaceCleanupStrayRoot>()
  const projectPaths: string[] = []
  const layout = settings.nestWorkspaces ? 'nested' : 'flat'

  for (const repo of store.getRepos()) {
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      if (!isFolderRepo(repo)) {
        skip('remote-host')
      }
      continue
    }
    projectPaths.push(repo.path)
    if (isFolderRepo(repo)) {
      continue
    }
    if (isWslUncPath(repo.path) || getWorktreeMirrorDistro(store, repo)) {
      skip('wsl')
      continue
    }
    let rootPath: string
    try {
      rootPath = computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, settings))
    } catch {
      skip('unreadable')
      continue
    }
    if (isWslUncPath(rootPath)) {
      skip('wsl')
      continue
    }
    const key = normalizeRuntimePathForComparison(rootPath)
    const root = rootsByKey.get(key) ?? {
      path: rootPath,
      layout,
      repoIds: [],
      containers: new Map<string, string[]>()
    }
    root.repoIds.push(repo.id)
    if (layout === 'nested') {
      const container = getRuntimePathBasename(repo.path).replace(/\.git$/, '')
      root.containers.set(container, [...(root.containers.get(container) ?? []), repo.id])
    }
    rootsByKey.set(key, root)
  }

  const roots: WorkspaceCleanupStrayRoot[] = []
  for (const root of rootsByKey.values()) {
    if (projectPaths.some((projectPath) => isPathInsideOrEqual(root.path, projectPath))) {
      skip('holds-projects')
      continue
    }
    roots.push(root)
  }
  return { roots, skipped, projectPaths }
}
