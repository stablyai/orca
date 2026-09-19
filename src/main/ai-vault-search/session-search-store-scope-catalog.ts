import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import type { SessionSearchScopeCatalog } from './session-search-scope-catalog'

// Only what the catalog reads, so a partial store satisfies it.
export type SessionSearchScopeStore = {
  getRepos(): readonly (SessionSearchScopeCatalog['repos'][number] & {
    connectionId?: string | null
    executionHostId?: ProjectHostSetup['hostId'] | null
  })[]
  getProjects(): readonly SessionSearchScopeCatalog['projects'][number][]
  getProjectHostSetups(): readonly (SessionSearchScopeCatalog['projectHostSetups'][number] & {
    hostId: ProjectHostSetup['hostId']
  })[]
  getAllWorktreeMeta(): Record<string, WorktreeMeta>
  getAllWorktreeMetaForHost?: (executionHostId: ExecutionHostId) => Record<string, WorktreeMeta>
  getSettings(): Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'>
}

// Filtered by host: a desktop's store also holds its SSH and runtime hosts'
// catalogs, whose directories do not exist on this machine.
export function sessionSearchScopeCatalogFromStore(
  store: SessionSearchScopeStore,
  executionHostId: ExecutionHostId
): SessionSearchScopeCatalog {
  const settings = store.getSettings()
  return {
    repos: store.getRepos().filter((repo) => getRepoExecutionHostId(repo) === executionHostId),
    projects: store.getProjects(),
    projectHostSetups: store
      .getProjectHostSetups()
      .filter((setup) => normalizeExecutionHostId(setup.hostId) === executionHostId),
    worktreeMeta: readAllWorktreeMetaForHost(store, executionHostId),
    settings: { workspaceDir: settings.workspaceDir, nestWorkspaces: settings.nestWorkspaces }
  }
}
