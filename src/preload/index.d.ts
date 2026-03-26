import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Repo,
  Worktree,
  WorktreeMeta,
  PRInfo,
  PRCheckDetail,
  IssueInfo,
  GlobalSettings,
  OrcaHooks,
  PersistedUIState,
  WorkspaceSessionState,
  UpdateStatus,
  DirEntry,
  GitStatusEntry,
  GitDiffResult,
  SearchOptions,
  SearchResult
} from '../../shared/types'

type ReposApi = {
  list: () => Promise<Repo[]>
  add: (args: { path: string }) => Promise<Repo>
  remove: (args: { repoId: string }) => Promise<void>
  update: (args: {
    repoId: string
    updates: Partial<Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef'>>
  }) => Promise<Repo>
  pickFolder: () => Promise<string | null>
  getGitUsername: (args: { repoId: string }) => Promise<string>
  getBaseRefDefault: (args: { repoId: string }) => Promise<string>
  searchBaseRefs: (args: { repoId: string; query: string; limit?: number }) => Promise<string[]>
  onChanged: (callback: () => void) => () => void
}

type WorktreesApi = {
  list: (args: { repoId: string }) => Promise<Worktree[]>
  listAll: () => Promise<Worktree[]>
  create: (args: { repoId: string; name: string; baseBranch?: string }) => Promise<Worktree>
  remove: (args: { worktreeId: string; force?: boolean }) => Promise<void>
  updateMeta: (args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => Promise<Worktree>
  onChanged: (callback: (data: { repoId: string }) => void) => () => void
}

type PtyApi = {
  spawn: (opts: { cols: number; rows: number; cwd?: string }) => Promise<{ id: string }>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => Promise<void>
  onData: (callback: (data: { id: string; data: string }) => void) => () => void
  onExit: (callback: (data: { id: string; code: number }) => void) => () => void
}

type GhApi = {
  prForBranch: (args: { repoPath: string; branch: string }) => Promise<PRInfo | null>
  issue: (args: { repoPath: string; number: number }) => Promise<IssueInfo | null>
  listIssues: (args: { repoPath: string; limit?: number }) => Promise<IssueInfo[]>
  prChecks: (args: { repoPath: string; prNumber: number }) => Promise<PRCheckDetail[]>
  updatePRTitle: (args: { repoPath: string; prNumber: number; title: string }) => Promise<boolean>
}

type SettingsApi = {
  get: () => Promise<GlobalSettings>
  set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
  listFonts: () => Promise<string[]>
}

type ShellApi = {
  openPath: (path: string) => Promise<void>
  openUrl: (url: string) => Promise<void>
  openFilePath: (path: string) => Promise<void>
  openFileUri: (uri: string) => Promise<void>
  pathExists: (path: string) => Promise<boolean>
}

type HooksApi = {
  check: (args: { repoId: string }) => Promise<{ hasHooks: boolean; hooks: OrcaHooks | null }>
}

type CacheApi = {
  getGitHub: () => Promise<{
    pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
    issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
  }>
  setGitHub: (args: {
    cache: {
      pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
      issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
    }
  }) => Promise<void>
}

type SessionApi = {
  get: () => Promise<WorkspaceSessionState>
  set: (args: WorkspaceSessionState) => Promise<void>
}

type UpdaterApi = {
  getVersion: () => Promise<string>
  getStatus: () => Promise<UpdateStatus>
  check: () => Promise<void>
  download: () => Promise<void>
  quitAndInstall: () => Promise<void>
  onStatus: (callback: (status: UpdateStatus) => void) => () => void
}

type UIApi = {
  get: () => Promise<PersistedUIState>
  set: (args: Partial<PersistedUIState>) => Promise<void>
  onOpenSettings: (callback: () => void) => () => void
  onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
  readClipboardText: () => Promise<string>
  writeClipboardText: (text: string) => Promise<void>
  onFileDrop: (callback: (data: { path: string }) => void) => () => void
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
}

type FsApi = {
  readDir: (args: { dirPath: string }) => Promise<DirEntry[]>
  readFile: (args: { filePath: string }) => Promise<{ content: string; isBinary: boolean }>
  writeFile: (args: { filePath: string; content: string }) => Promise<void>
  stat: (args: {
    filePath: string
  }) => Promise<{ size: number; isDirectory: boolean; mtime: number }>
  search: (args: SearchOptions) => Promise<SearchResult>
}

type GitApi = {
  status: (args: { worktreePath: string }) => Promise<GitStatusEntry[]>
  diff: (args: {
    worktreePath: string
    filePath: string
    staged: boolean
  }) => Promise<GitDiffResult>
  stage: (args: { worktreePath: string; filePath: string }) => Promise<void>
  unstage: (args: { worktreePath: string; filePath: string }) => Promise<void>
  discard: (args: { worktreePath: string; filePath: string }) => Promise<void>
}

type Api = {
  repos: ReposApi
  worktrees: WorktreesApi
  pty: PtyApi
  gh: GhApi
  settings: SettingsApi
  shell: ShellApi
  hooks: HooksApi
  cache: CacheApi
  session: SessionApi
  updater: UpdaterApi
  fs: FsApi
  git: GitApi
  ui: UIApi
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
