import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { ProjectHostSetup } from '../../../shared/project/project-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { readAllWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import type {
  SessionSearchScopeCatalog,
  SessionSearchScopeCatalogSource
} from './session-search-scope-catalog'

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

// The store includes other hosts’ paths; expose only the answering host’s registrations.
function sessionSearchScopeCatalogFromStore(
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

// Desktop and orcad read per search so added repos and renamed workspaces are in scope at once.
export function localSessionSearchScopeCatalogSource(
  store: SessionSearchScopeStore
): SessionSearchScopeCatalogSource {
  return () => sessionSearchScopeCatalogFromStore(store, LOCAL_EXECUTION_HOST_ID)
}
