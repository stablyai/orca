import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  HostRepoCatalogSnapshot,
  ListReposForExecutionHostArgs
} from '../../shared/host-repo-catalog-contract'
import type {
  NestedRepoScanResult,
  ProjectGroup,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../shared/project-group-types'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  ProjectUpdateArgs
} from '../../shared/project-types'
import type { BaseRefDefaultResult, BaseRefSearchResult, Repo } from '../../shared/repo-types'

export type RepositoryApi = {
  list: () => Promise<Repo[]>
  listForExecutionHost?: (args: ListReposForExecutionHostArgs) => Promise<HostRepoCatalogSnapshot>
  // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
  add: (args: {
    path: string
    kind?: 'git' | 'folder'
  }) => Promise<{ repo: Repo } | { error: string }>
  remove: (args: { repoId: string }) => Promise<void>
  // Forget a project on one execution host only, leaving the same repo id on other hosts intact.
  removeForHost: (args: { repoId: string; hostId: string }) => Promise<void>
  reorder: (args: { orderedIds: string[] }) => Promise<{ status: 'applied' | 'rejected' }>
  reorderForHost: (args: {
    orderedIds: string[]
    hostId: string
  }) => Promise<{ status: 'applied' | 'rejected' }>
  update: (args: {
    repoId: string
    hostId?: ExecutionHostId
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'repoIcon'
        | 'upstream'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'worktreeBasePath'
        | 'kind'
        | 'issueSourcePreference'
        | 'externalWorktreeVisibilityPromptDismissedAt'
        | 'externalWorktreeInboxBaselinePaths'
        | 'importedExternalWorktreePaths'
        | 'customWorktreeVisibilitySources'
        | 'worktreeVisibilitySourcePreferences'
        | 'projectGroupId'
        | 'projectGroupOrder'
        | 'forkSyncMode'
      >
    > & {
      externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
      agentWorktreeVisibility?: Repo['agentWorktreeVisibility'] | null
      sourceControlAi?: Repo['sourceControlAi'] | null
      externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
    }
  }) => Promise<Repo>
  pickFolder: () => Promise<string | null>
  pickFolders: () => Promise<string[]>
  pickDirectory: () => Promise<string | null>
  clone: (args: { url: string; destination: string }) => Promise<Repo>
  cloneRemote: (args: { connectionId: string; url: string; destination: string }) => Promise<Repo>
  createRemote: (args: {
    connectionId: string
    parentPath: string
    name: string
    kind: 'git' | 'folder'
  }) => Promise<{ repo: Repo } | { error: string }>
  cloneAbort: () => Promise<void>
  // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
  addRemote: (args: {
    connectionId: string
    remotePath: string
    displayName?: string
    kind?: 'git' | 'folder'
  }) => Promise<{ repo: Repo } | { error: string }>
  // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
  create: (args: {
    parentPath: string
    name: string
    kind: 'git' | 'folder'
  }) => Promise<{ repo: Repo } | { error: string }>
  isGitAvailable: () => Promise<boolean>
  getDefaultCreateProjectParent: () => Promise<string>
  onCloneProgress: (callback: (data: { phase: string; percent: number }) => void) => () => void
  getGitUsername: (args: { repoId: string }) => Promise<string>
  getBaseRefDefault: (args: {
    repoId: string
    hostId?: ExecutionHostId
  }) => Promise<BaseRefDefaultResult>
  searchBaseRefs: (args: {
    repoId: string
    query: string
    limit?: number
    hostId?: ExecutionHostId
  }) => Promise<string[]>
  searchBaseRefDetails: (args: {
    repoId: string
    query: string
    limit?: number
    hostId?: ExecutionHostId
  }) => Promise<BaseRefSearchResult[]>
  onChanged: (callback: () => void) => () => void
}

export type ProjectsApi = {
  list: () => Promise<Project[]>
  update: (args: ProjectUpdateArgs) => Promise<Project | null>
  listHostSetups: () => Promise<ProjectHostSetup[]>
  createHostSetup: (args: ProjectHostSetupCreateArgs) => Promise<ProjectHostSetupCreateResult>
  setupExistingFolder: (args: ProjectHostSetupExistingFolderArgs) => Promise<ProjectHostSetupResult>
  updateHostSetup: (args: ProjectHostSetupUpdateArgs) => Promise<ProjectHostSetupUpdateResult>
  deleteHostSetup: (args: ProjectHostSetupDeleteArgs) => Promise<ProjectHostSetupDeleteResult>
}

export type ProjectGroupsApi = {
  list: () => Promise<ProjectGroup[]>
  create: (args: {
    name: string
    parentPath?: string | null
    connectionId?: string | null
    parentGroupId?: string | null
    createdFrom?: ProjectGroup['createdFrom']
  }) => Promise<ProjectGroup>
  update: (args: {
    groupId: string
    updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
  }) => Promise<ProjectGroup | null>
  delete: (args: { groupId: string }) => Promise<boolean>
  moveProject: (args: {
    projectId: string
    groupId: string | null
    order?: number
  }) => Promise<Repo | null>
  scanNested: (args: {
    path: string
    connectionId?: string
    scanId?: string
    options?: Record<string, unknown>
  }) => Promise<NestedRepoScanResult>
  cancelNestedScan: (args: { scanId: string }) => Promise<boolean>
  onNestedScanProgress: (
    callback: (data: { scanId: string; scan: NestedRepoScanResult }) => void
  ) => () => void
  importNested: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    mode: ProjectGroupImportMode
  }) => Promise<ProjectGroupImportResult>
}
