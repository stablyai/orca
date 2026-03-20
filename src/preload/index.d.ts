import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Repo,
  Worktree,
  WorktreeMeta,
  PRInfo,
  IssueInfo,
  GlobalSettings,
  OrcaHooks,
  PersistedUIState,
  WorkspaceSessionState
} from '../../shared/types'

interface ReposApi {
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

interface WorktreesApi {
  list: (args: { repoId: string }) => Promise<Worktree[]>
  listAll: () => Promise<Worktree[]>
  create: (args: { repoId: string; name: string; baseBranch?: string }) => Promise<Worktree>
  remove: (args: { worktreeId: string; force?: boolean }) => Promise<void>
  updateMeta: (args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => Promise<Worktree>
  onChanged: (callback: (data: { repoId: string }) => void) => () => void
}

interface PtyApi {
  spawn: (opts: { cols: number; rows: number; cwd?: string }) => Promise<{ id: string }>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => Promise<void>
  onData: (callback: (data: { id: string; data: string }) => void) => () => void
  onExit: (callback: (data: { id: string; code: number }) => void) => () => void
}

interface GhApi {
  prForBranch: (args: { repoPath: string; branch: string }) => Promise<PRInfo | null>
  issue: (args: { repoPath: string; number: number }) => Promise<IssueInfo | null>
  listIssues: (args: { repoPath: string; limit?: number }) => Promise<IssueInfo[]>
}

interface SettingsApi {
  get: () => Promise<GlobalSettings>
  set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
  listFonts: () => Promise<string[]>
}

interface ShellApi {
  openPath: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
}

interface HooksApi {
  check: (args: { repoId: string }) => Promise<{ hasHooks: boolean; hooks: OrcaHooks | null }>
}

interface CacheApi {
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

interface SessionApi {
  get: () => Promise<WorkspaceSessionState>
  set: (args: WorkspaceSessionState) => Promise<void>
}

interface UIApi {
  get: () => Promise<PersistedUIState>
  set: (args: Partial<PersistedUIState>) => Promise<void>
  onOpenSettings: (callback: () => void) => () => void
  onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
}

interface Api {
  repos: ReposApi
  worktrees: WorktreesApi
  pty: PtyApi
  gh: GhApi
  settings: SettingsApi
  shell: ShellApi
  hooks: HooksApi
  cache: CacheApi
  session: SessionApi
  ui: UIApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
