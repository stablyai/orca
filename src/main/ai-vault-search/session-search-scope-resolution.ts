import { toAiVaultProjectKey } from '../../shared/ai-vault-project-key'
import type { AiVaultSearchScopeIdentity } from '../../shared/ai-vault-search-scope'
import {
  getRepoIdFromWorktreeId,
  getRepoMainWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdsEqual
} from '../../shared/worktree/id'
import { areRuntimePathsEqual } from '../../shared/worktree/ownership'
import type { SessionSearchScopeCatalog } from './session-search-scope-catalog'
import type { SessionSearchHostScope } from './session-search-service'
import { managedWorktreeDirectories, ScopePathSet } from './session-search-scope-paths'

type ScopeRepo = SessionSearchScopeCatalog['repos'][number]

/** `unknown` says this host has no such workspace or project. Never a reason to search everything. */
export function resolveSessionSearchScope(
  within: AiVaultSearchScopeIdentity,
  catalog: SessionSearchScopeCatalog | null
): SessionSearchHostScope {
  if (!catalog) {
    return { kind: 'unknown' }
  }
  const paths =
    within.kind === 'workspace'
      ? resolveWorkspaceScope(within.worktreeId, catalog)
      : resolveProjectScope(within.projectKey, catalog)
  return paths.length > 0 ? { kind: 'resolved', paths } : { kind: 'unknown' }
}

// Transcripts are keyed by working directory, so a renamed workspace's own
// history lives under the paths it used to occupy.
function resolveWorkspaceScope(worktreeId: string, catalog: SessionSearchScopeCatalog): string[] {
  const repo = repoById(catalog, getRepoIdFromWorktreeId(worktreeId))
  if (!repo) {
    return []
  }
  const registeredId = registeredWorktreeId(worktreeId, repo, catalog)
  if (registeredId === null) {
    return []
  }
  const paths = new ScopePathSet()
  paths.add(splitWorktreeIdForFilesystem(registeredId)?.worktreePath)
  addPriorWorktreePaths(paths, registeredId, catalog)
  return paths.folded()
}

// Through the registry rather than reading the path out of the id: the id is
// client-supplied, and a scope identity must not be a way to hand the host a
// path to search.
function registeredWorktreeId(
  worktreeId: string,
  repo: ScopeRepo,
  catalog: SessionSearchScopeCatalog
): string | null {
  if (catalog.worktreeMeta[worktreeId]) {
    return worktreeId
  }
  const registered = Object.keys(catalog.worktreeMeta).find((key) =>
    worktreeIdsEqual(key, worktreeId)
  )
  if (registered) {
    return registered
  }
  // The checkout and a folder project's workspaces sit at the repo path, which
  // this host recorded when it registered the repo.
  const named = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  return named && areRuntimePathsEqual(named, repo.path) ? getRepoMainWorktreeId(repo) : null
}

// A project set up on several hosts resolves on each, the key being the
// project's id and not a path.
function resolveProjectScope(projectKey: string, catalog: SessionSearchScopeCatalog): string[] {
  const paths = new ScopePathSet()
  const repoIds = new Set<string>()
  for (const setup of catalog.projectHostSetups) {
    if (toAiVaultProjectKey(setup.projectId, setup.repoId) === projectKey) {
      repoIds.add(setup.repoId)
      paths.add(setup.path)
      paths.add(setup.worktreeBasePath)
    }
  }
  const projectId = projectKey.startsWith('project:') ? projectKey.slice('project:'.length) : null
  for (const project of catalog.projects) {
    if (project.id === projectId) {
      for (const repoId of project.sourceRepoIds) {
        repoIds.add(repoId)
      }
    }
  }
  // A repo-keyed project is the repo itself, which no setup row has to mention.
  if (projectKey.startsWith('repo:')) {
    repoIds.add(projectKey.slice('repo:'.length))
  }
  for (const [worktreeId, meta] of Object.entries(catalog.worktreeMeta)) {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    if (toAiVaultProjectKey(meta.projectId ?? null, repoId) === projectKey) {
      repoIds.add(repoId)
    }
  }
  for (const repoId of repoIds) {
    const repo = repoById(catalog, repoId)
    if (repo) {
      addRepoScopePaths(paths, repo, catalog)
    }
  }
  return paths.folded()
}

function addRepoScopePaths(
  paths: ScopePathSet,
  repo: ScopeRepo,
  catalog: SessionSearchScopeCatalog
): void {
  paths.add(repo.path)
  for (const directory of managedWorktreeDirectories(repo, catalog.settings)) {
    paths.add(directory)
  }
  for (const worktreeId of Object.keys(catalog.worktreeMeta)) {
    if (getRepoIdFromWorktreeId(worktreeId) !== repo.id) {
      continue
    }
    paths.add(splitWorktreeIdForFilesystem(worktreeId)?.worktreePath)
    addPriorWorktreePaths(paths, worktreeId, catalog)
  }
}

// A prior path another workspace now occupies is that workspace's: the id
// embeds the path, so the claimant's id *is* the prior id.
function addPriorWorktreePaths(
  paths: ScopePathSet,
  worktreeId: string,
  catalog: SessionSearchScopeCatalog
): void {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  for (const priorWorktreeId of catalog.worktreeMeta[worktreeId]?.priorWorktreeIds ?? []) {
    if (priorWorktreeId === worktreeId || catalog.worktreeMeta[priorWorktreeId]) {
      continue
    }
    const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
    if (parsed?.repoId === repoId) {
      paths.add(parsed.worktreePath)
    }
  }
}

function repoById(catalog: SessionSearchScopeCatalog, repoId: string): ScopeRepo | undefined {
  return catalog.repos.find((repo) => repo.id === repoId)
}
