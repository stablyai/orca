import { findLocalFolderWorkspaceRuntimeRepo } from '../../shared/folder-workspaces/folder-workspace-execution-host'
import { resolve } from 'node:path'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import {
  getLocalProjectWorktreeGitOptions,
  type LocalProjectWorktreeGitOptions
} from '../workspaces/execution-host/project-runtime-git-options'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'
import { WORKTREE_METADATA_DOMAINS } from '../persistence/profile-save-domains'

const metadataIndexes = new WeakMap<RuntimeStore, { paths: Map<string, Set<string>> | null }>()

function metadataRepoIndex(store: RuntimeStore): Map<string, Set<string>> {
  let cached = metadataIndexes.get(store)
  if (!cached && store.onStateWritten) {
    cached = { paths: null }
    metadataIndexes.set(store, cached)
    const state = cached
    store.onStateWritten((domains) => {
      if (
        !domains ||
        domains.some((domain) => WORKTREE_METADATA_DOMAINS.some((item) => item === domain))
      ) {
        state.paths = null
      }
    })
  }
  if (cached?.paths) {
    return cached.paths
  }
  const paths = new Map<string, Set<string>>()
  const metadata = typeof store.getAllWorktreeMeta === 'function' ? store.getAllWorktreeMeta() : {}
  for (const key of Object.keys(metadata)) {
    const parsed = splitWorktreeId(key)
    if (!parsed) {
      continue
    }
    const path = comparableLocalPath(parsed.worktreePath)
    const repos = paths.get(path) ?? new Set<string>()
    repos.add(parsed.repoId)
    paths.set(path, repos)
  }
  if (cached) {
    cached.paths = paths
  }
  return paths
}

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function getCandidateLocalWorktreePaths(
  worktreePath: string,
  resolvedWorktreePath: string
): Set<string> {
  return new Set([worktreePath, resolvedWorktreePath].map(comparableLocalPath))
}

function collectRepoIdsWithRegisteredWorktreeMeta(
  store: RuntimeStore,
  candidatePaths: Set<string>
): Set<string> {
  const index = metadataRepoIndex(store)
  const repoIds = new Set<string>()
  for (const path of candidatePaths) {
    for (const repoId of index.get(path) ?? []) {
      repoIds.add(repoId)
    }
  }
  return repoIds
}

export function getLocalRepoForRegisteredWorktree(
  store: RuntimeStore,
  worktreePath: string,
  resolvedWorktreePath: string
): Repo | undefined {
  if (typeof store.getRepos !== 'function') {
    return undefined
  }

  const candidatePaths = getCandidateLocalWorktreePaths(worktreePath, resolvedWorktreePath)
  // Lazily scan meta once, not once per repo, on frequent IPC paths.
  let repoIdsWithMeta: Set<string> | undefined
  return store
    .getRepos()
    .find(
      (repo) =>
        !repo.connectionId &&
        (candidatePaths.has(comparableLocalPath(repo.path)) ||
          (repoIdsWithMeta ??= collectRepoIdsWithRegisteredWorktreeMeta(store, candidatePaths)).has(
            repo.id
          ))
    )
}

/** Reuse a resolved repo without scanning worktree metadata again. */
export function getLocalGitOptionsForRepo(
  store: RuntimeStore,
  repo: Repo | undefined
): LocalProjectWorktreeGitOptions {
  if (!repo || typeof store.getProjects !== 'function' || typeof store.getSettings !== 'function') {
    return {}
  }
  // Match project Git/terminal runtime even for Windows-spelled paths.
  return getLocalProjectWorktreeGitOptions(store, repo)
}

export function getLocalGitOptionsForRegisteredWorktree(
  store: RuntimeStore,
  worktreePath: string,
  resolvedWorktreePath: string
): LocalProjectWorktreeGitOptions {
  if (typeof store.getProjects !== 'function' || typeof store.getSettings !== 'function') {
    return {}
  }

  return getLocalGitOptionsForRepo(
    store,
    getLocalRepoForRegisteredWorktree(store, worktreePath, resolvedWorktreePath)
  )
}

/** Scoped Explorer reads also originate in folders that have no registered Git root. */
export function getLocalGitOptionsForWorkspaceRead(
  store: RuntimeStore,
  path: string
): LocalProjectWorktreeGitOptions {
  const registered = getLocalRepoForRegisteredWorktree(store, path, path)
  if (registered) {
    return getLocalGitOptionsForRepo(store, registered)
  }
  const folderWorkspaces = store.getFolderWorkspaces?.() ?? []
  const state = {
    folderWorkspaces,
    projectGroups: store.getProjectGroups?.() ?? [],
    repos: store.getRepos()
  }
  const options = folderWorkspaces
    .filter((folder) => comparableLocalPath(folder.folderPath) === comparableLocalPath(path))
    .map((folder) =>
      getLocalGitOptionsForRepo(
        store,
        findLocalFolderWorkspaceRuntimeRepo(state, folder.id, folder)
      )
    )
  if (new Set(options.map((option) => option.wslDistro ?? '')).size > 1) {
    throw new Error('workspace_execution_host_unresolved')
  }
  return options[0] ?? {}
}
