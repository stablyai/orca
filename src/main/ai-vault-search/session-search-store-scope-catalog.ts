import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { assignNestedRepoDirNames } from '../ipc/worktree-nested-dir-name'
import type { SessionSearchScopeCatalog } from './session-search-scope-catalog'

// Only what the catalog reads, so a partial store satisfies it.
export type SessionSearchScopeStore = {
  getRepos(): readonly (SessionSearchScopeCatalog['repos'][number] &
    Partial<Pick<Repo, 'addedAt' | 'gitRemoteIdentity'>> & {
      connectionId?: string | null
      executionHostId?: ProjectHostSetup['hostId'] | null
    })[]
  getProjects(): readonly SessionSearchScopeCatalog['projects'][number][]
  getProjectHostSetups(): readonly (SessionSearchScopeCatalog['projectHostSetups'][number] & {
    hostId: ProjectHostSetup['hostId']
  })[]
  getAllWorktreeMeta(): Record<string, WorktreeMeta>
  getAllWorktreeMetaForHost?: (executionHostId: ExecutionHostId) => Record<string, WorktreeMeta>
  getSettings(): Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'worktreeLayout'>
}

// Filtered by host: a desktop's store also holds its SSH and runtime hosts'
// catalogs, whose directories do not exist on this machine.
export function sessionSearchScopeCatalogFromStore(
  store: SessionSearchScopeStore,
  executionHostId: ExecutionHostId
): SessionSearchScopeCatalog {
  const settings = store.getSettings()
  const repos = store.getRepos().filter((repo) => getRepoExecutionHostId(repo) === executionHostId)
  const nestedRepoDirNames = assignNestedRepoDirNames(repos, settings)
  return {
    repos,
    projects: store.getProjects(),
    projectHostSetups: store
      .getProjectHostSetups()
      .filter((setup) => normalizeExecutionHostId(setup.hostId) === executionHostId),
    worktreeMeta: readAllWorktreeMetaForHost(store, executionHostId),
    settings: {
      workspaceDir: settings.workspaceDir,
      nestWorkspaces: settings.nestWorkspaces,
      ...(settings.worktreeLayout ? { worktreeLayout: settings.worktreeLayout } : {})
    },
    ...(nestedRepoDirNames.size > 0
      ? { nestedRepoDirNames: Object.fromEntries(nestedRepoDirNames) }
      : {})
  }
}
