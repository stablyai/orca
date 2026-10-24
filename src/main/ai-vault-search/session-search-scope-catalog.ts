import type { ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceProjectOwner } from '../../shared/project-host-setup-lookup'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

// Use the answering host’s persisted registrations to avoid Git scans.
export type SessionSearchScopeCatalog = {
  repos: readonly Repo[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  executionHostId?: ExecutionHostId
  /** Registered workspaces of this host, keyed by worktree id. */
  worktreeMeta: Readonly<
    Record<
      string,
      Pick<WorktreeMeta, 'projectId' | 'priorWorktreeIds'> &
        Partial<Omit<WorkspaceProjectOwner, 'repoId'>>
    >
  >
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>
}

export type SessionSearchScopeCatalogSource = () => SessionSearchScopeCatalog | null

// Hosts without a catalog must reject scopes rather than widen searches.
let readCatalog: SessionSearchScopeCatalogSource | null = null

export function installSessionSearchScopeCatalogSource(
  source: SessionSearchScopeCatalogSource | null
): void {
  readCatalog = source
}

export function sessionSearchScopeCatalog(): SessionSearchScopeCatalog | null {
  return readCatalog?.() ?? null
}

export function resetSessionSearchScopeCatalogForTests(): void {
  readCatalog = null
}
