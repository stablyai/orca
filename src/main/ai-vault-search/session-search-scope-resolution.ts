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

/** Unknown scope must never widen to an unrestricted search. */
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

// Transcripts retain the working directory used before a workspace rename.
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

// Resolve client-supplied IDs through registration to reject arbitrary search paths.
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
  // Checkouts and folder workspaces can use the registered repo path without a workspace row.
  const named = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  return named && areRuntimePathsEqual(named, repo.path) ? getRepoMainWorktreeId(repo) : null
}

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

// A prior ID registered again belongs to its current workspace, not its former owner.
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
