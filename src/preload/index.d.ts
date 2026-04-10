import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  CreateWorktreeResult,
  CreateWorktreeArgs
} from '../../shared/types'
import type { PreloadApi } from './api-types'

type ReposApi = {
  list: () => Promise<Repo[]>
  add: (args: { path: string; kind?: 'git' | 'folder' }) => Promise<Repo>
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
  }) => Promise<{ id: string }>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => Promise<void>
  hasChildProcesses: (id: string) => Promise<boolean>
  onData: (callback: (data: { id: string; data: string }) => void) => () => void
  onExit: (callback: (data: { id: string; code: number }) => void) => () => void
}

type GhApi = {
  prForBranch: (args: { repoPath: string; branch: string }) => Promise<PRInfo | null>
  issue: (args: { repoPath: string; number: number }) => Promise<IssueInfo | null>
  listIssues: (args: { repoPath: string; limit?: number }) => Promise<IssueInfo[]>
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
  pickImage: () => Promise<string | null>
  copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
}

type Api = PreloadApi & {
  repos: ReposApi
  worktrees: WorktreesApi
  pty: PtyApi
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
