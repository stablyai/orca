export const LOCAL_WORKTREE_ID = 'repo-local::/local/project'
export const WSL_WORKTREE_ID = 'repo-wsl::C:\\work\\project'
export const SSH_A_WORKTREE_ID = 'repo-ssh-a::/srv/a/project'
export const SSH_B_WORKTREE_ID = 'repo-ssh-b::/srv/b/project'
export const SSH_C_WORKTREE_ID = 'repo-ssh-c::/srv/c/project'
export const RUNTIME_WORKTREE_ID = 'repo-runtime::/srv/runtime/project'

export type FolderFixture = {
  id: string
  projectGroupId: string
  name: string
  folderPath: string
  connectionId?: string | null
  executionHostId?: string | null
  linkedTask: null
  comment: string
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  lastActivityAt: number
  createdAt: number
  updatedAt: number
}

export type ProjectGroupFixture = {
  id: string
  name: string
  parentPath: string | null
  parentGroupId: string | null
  createdFrom: 'manual'
  tabOrder: number
  isCollapsed: boolean
  color: string | null
  createdAt: number
  updatedAt: number
}

export const SSH_FOLDER: FolderFixture = {
  id: 'folder-ssh-b',
  projectGroupId: 'group-1',
  name: 'SSH B folder',
  folderPath: '/srv/b/folder',
  connectionId: 'box-b',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}

export type RepoFixture = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  addedAt: number
  connectionId?: string
  executionHostId?: 'local' | `runtime:${string}`
  projectGroupId?: string
}

export type ResolvedWorktreeFixture = {
  id: string
  repoId: string
  hostId: string
  path: string
  head: string
  branch: string
  isBare: boolean
  isMainWorktree: boolean
  displayName: string
  comment: string
  linkedIssue: null
  linkedPR: null
  linkedLinearIssue: null
  linkedLinearIssueWorkspaceId: null
  linkedLinearIssueOrganizationUrlKey: null
  linkedGitLabMR: null
  linkedGitLabIssue: null
  linkedBitbucketPR: null
  linkedAzureDevOpsPR: null
  linkedGiteaPR: null
  linkedWorkItem: null
  linkedTaskSourceContext: null
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  lastActivityAt: number
  parentWorktreeId: null
  childWorktreeIds: string[]
  lineage: null
  git: {
    path: string
    head: string
    branch: string
    isBare: boolean
    isMainWorktree: boolean
  }
}

export const REPOS: RepoFixture[] = [
  {
    id: 'repo-local',
    path: '/local/project',
    displayName: 'local',
    badgeColor: '#000000',
    addedAt: 0
  },
  {
    id: 'repo-wsl',
    path: 'C:\\work\\project',
    displayName: 'wsl',
    badgeColor: '#000000',
    addedAt: 0,
    executionHostId: 'local' as const
  },
  ...(['a', 'b', 'c'] as const).map((suffix) => ({
    id: `repo-ssh-${suffix}`,
    path: `/srv/${suffix}/project`,
    displayName: `ssh-${suffix}`,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: `box-${suffix}`
  })),
  {
    id: 'repo-runtime',
    path: '/srv/runtime/project',
    displayName: 'runtime',
    badgeColor: '#000000',
    addedAt: 0,
    executionHostId: 'runtime:environment-1' as const
  }
]

export function resolvedWorktree(
  id: string,
  repoId: string,
  path: string,
  hostId: string
): ResolvedWorktreeFixture {
  const git = {
    path,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true
  }
  return {
    id,
    repoId,
    hostId,
    ...git,
    displayName: repoId,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git
  }
}

export type ProviderKey = 'local' | 'box-a' | 'box-b' | 'box-c'
export type ListedSession = { id: string; cwd: string; worktreeId?: string; wslDistro?: string }

export type ScopedTargetFixture = {
  worktree: ResolvedWorktreeFixture
  provider: { connectionId: string | null } | null
}

export type RuntimeInternals = {
  resolvedWorktreeCache: {
    worktrees: ResolvedWorktreeFixture[]
    platformByRepoId: Map<string, NodeJS.Platform>
    expiresAt: number
  } | null
  ptysById: Map<string, { connected: boolean }>
  mobileSessionTabsByWorktree: Map<string, unknown>
  resolveScopedPtyControllerInventoryTarget: (
    worktreeId: string,
    worktree?: ResolvedWorktreeFixture | null,
    connectionId?: string | null
  ) => ScopedTargetFixture | null
  listScopedPtyClassificationWorktrees: (target: ScopedTargetFixture) => ResolvedWorktreeFixture[]
  publishRecoveredSshMobileSessionTabs: (targetId: string, generation: number) => Promise<void>
  sshRelayRecoveryGenerationByTargetId: Map<string, number>
  resolveFolderWorkspaceConnectionId: (folderWorkspace: FolderFixture) => string | null
  notifyMobileSessionTabsChangedNow: (worktreeId: string) => void
}
