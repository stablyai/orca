import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  CreateWorktreeResult,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  GitHubViewer,
  CreateWorktreeArgs,
  OpenCodeStatusEvent
} from '../../shared/types'
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import type { PreloadApi } from './api-types'

type ReposApi = {
  list: () => Promise<Repo[]>
  add: (args: {
    path: string
    kind?: 'git' | 'folder'
  }) => Promise<{ repo: Repo } | { error: string }>
  addRemote: (args: {
    connectionId: string
    remotePath: string
    displayName?: string
    kind?: 'git' | 'folder'
  }) => Promise<{ repo: Repo } | { error: string }>
  remove: (args: { repoId: string }) => Promise<void>
  update: (args: {
    repoId: string
    updates: Partial<
      Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef' | 'kind'>
    >
  }) => Promise<Repo>
  pickFolder: () => Promise<string | null>
  pickDirectory: () => Promise<string | null>
  clone: (args: { url: string; destination: string }) => Promise<Repo>
  cloneAbort: () => Promise<void>
  onCloneProgress: (callback: (data: { phase: string; percent: number }) => void) => () => void
  getGitUsername: (args: { repoId: string }) => Promise<string>
  getBaseRefDefault: (args: { repoId: string }) => Promise<string>
  searchBaseRefs: (args: { repoId: string; query: string; limit?: number }) => Promise<string[]>
  onChanged: (callback: () => void) => () => void
}

type WorktreesApi = {
  list: (args: { repoId: string }) => Promise<Worktree[]>
  listAll: () => Promise<Worktree[]>
  create: (args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
  remove: (args: { worktreeId: string; force?: boolean }) => Promise<void>
  updateMeta: (args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => Promise<Worktree>
  persistSortOrder: (args: { orderedIds: string[] }) => Promise<void>
  onChanged: (callback: (data: { repoId: string }) => void) => () => void
}

type PtyApi = {
  spawn: (opts: {
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
    connectionId?: string | null
    worktreeId?: string
    sessionId?: string
  }) => Promise<{
    id: string
    snapshot?: string
    snapshotCols?: number
    snapshotRows?: number
    isReattach?: boolean
    isAlternateScreen?: boolean
    coldRestore?: { scrollback: string; cwd: string }
  }>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  signal: (id: string, signal: string) => void
  kill: (id: string) => Promise<void>
  ackColdRestore: (id: string) => void
  hasChildProcesses: (id: string) => Promise<boolean>
  getForegroundProcess: (id: string) => Promise<string | null>
  listSessions: () => Promise<{ id: string; cwd: string; title: string }[]>
  onData: (callback: (data: { id: string; data: string }) => void) => () => void
  onExit: (callback: (data: { id: string; code: number }) => void) => () => void
  onOpenCodeStatus: (callback: (event: OpenCodeStatusEvent) => void) => () => void
}

type GhApi = {
  viewer: () => Promise<GitHubViewer | null>
  repoSlug: (args: { repoPath: string }) => Promise<{ owner: string; repo: string } | null>
  prForBranch: (args: { repoPath: string; branch: string }) => Promise<PRInfo | null>
  issue: (args: { repoPath: string; number: number }) => Promise<IssueInfo | null>
  workItem: (args: { repoPath: string; number: number }) => Promise<GitHubWorkItem | null>
  workItemDetails: (args: {
    repoPath: string
    number: number
  }) => Promise<GitHubWorkItemDetails | null>
  prFileContents: (args: {
    repoPath: string
    prNumber: number
    path: string
    oldPath?: string
    status: GitHubPRFile['status']
    headSha: string
    baseSha: string
  }) => Promise<GitHubPRFileContents>
  listIssues: (args: { repoPath: string; limit?: number }) => Promise<IssueInfo[]>
  listWorkItems: (args: {
    repoPath: string
    limit?: number
    query?: string
  }) => Promise<GitHubWorkItem[]>
  prChecks: (args: {
    repoPath: string
    prNumber: number
    headSha?: string
    noCache?: boolean
  }) => Promise<PRCheckDetail[]>
  prComments: (args: {
    repoPath: string
    prNumber: number
    noCache?: boolean
  }) => Promise<PRComment[]>
  resolveReviewThread: (args: {
    repoPath: string
    threadId: string
    resolve: boolean
  }) => Promise<boolean>
  updatePRTitle: (args: { repoPath: string; prNumber: number; title: string }) => Promise<boolean>
  mergePR: (args: {
    repoPath: string
    prNumber: number
    method?: 'merge' | 'squash' | 'rebase'
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  checkOrcaStarred: () => Promise<boolean | null>
  starOrca: () => Promise<boolean>
}

type SettingsApi = {
  get: () => Promise<GlobalSettings>
  set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
  listFonts: () => Promise<string[]>
}

type CliApi = {
  getInstallStatus: () => Promise<CliInstallStatus>
  install: () => Promise<CliInstallStatus>
  remove: () => Promise<CliInstallStatus>
}

type NotificationsApi = {
  dispatch: (args: NotificationDispatchRequest) => Promise<NotificationDispatchResult>
  openSystemSettings: () => Promise<void>
}

type ShellApi = {
  openPath: (path: string) => Promise<void>
  openUrl: (url: string) => Promise<void>
  openFilePath: (path: string) => Promise<void>
  openFileUri: (uri: string) => Promise<void>
  pathExists: (path: string) => Promise<boolean>
  pickAttachment: () => Promise<string | null>
  pickImage: () => Promise<string | null>
  pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
  copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
}

type SshApi = {
  listTargets: () => Promise<SshTarget[]>
  addTarget: (args: { target: Omit<SshTarget, 'id'> }) => Promise<SshTarget>
  updateTarget: (args: {
    id: string
    updates: Partial<Omit<SshTarget, 'id'>>
  }) => Promise<SshTarget>
  removeTarget: (args: { id: string }) => Promise<void>
  importConfig: () => Promise<SshTarget[]>
  connect: (args: { targetId: string }) => Promise<SshConnectionState>
  disconnect: (args: { targetId: string }) => Promise<void>
  getState: (args: { targetId: string }) => Promise<SshConnectionState | null>
  testConnection: (args: { targetId: string }) => Promise<{ success: boolean; error?: string }>
  onStateChanged: (
    callback: (data: { targetId: string; state: SshConnectionState }) => void
  ) => () => void
  browseDir: (args: { targetId: string; dirPath: string }) => Promise<{
    entries: { name: string; isDirectory: boolean }[]
    resolvedPath: string
  }>
}

type Api = PreloadApi & {
  repos: ReposApi
  worktrees: WorktreesApi
  pty: PtyApi
  ssh: SshApi
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
