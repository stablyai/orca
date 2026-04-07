import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import type { PersistedState, Repo, WorktreeMeta, GlobalSettings } from '../shared/types'
import { getGitUsername } from './git/repo'
import {
  getDefaultPersistedState,
  getDefaultUIState,
  getDefaultRepoHookSettings,
  getDefaultWorkspaceSession
} from '../shared/constants'

// Why: this must be lazy (a getter, not a top-level const) because
// persistence.ts is imported before configureDevUserDataPath() runs in
// index.ts. A top-level const would capture the default 'orca' userData
// path, ignoring the dev-mode redirect to 'orca-dev'.
function getDataFile(): string {
  return join(app.getPath('userData'), 'orca-data.json')
}

function normalizeSortBy(sortBy: unknown): 'name' | 'recent' | 'repo' {
  if (sortBy === 'recent' || sortBy === 'repo' || sortBy === 'name') {
    return sortBy
  }
  if (sortBy === 'smart') {
    return 'recent'
  }
  return getDefaultUIState().sortBy
}

export class Store {
  private state: PersistedState
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private gitUsernameCache = new Map<string, string>()

  constructor() {
    this.state = this.load()
  }

  private load(): PersistedState {
    try {
      if (existsSync(getDataFile())) {
        const raw = readFileSync(getDataFile(), 'utf-8')
        const parsed = JSON.parse(raw) as PersistedState
        // Merge with defaults in case new fields were added
        const defaults = getDefaultPersistedState(homedir())
        return {
          ...defaults,
          ...parsed,
          settings: { ...defaults.settings, ...parsed.settings },
          ui: {
            ...defaults.ui,
            ...parsed.ui,
            sortBy: normalizeSortBy(parsed.ui?.sortBy)
          },
          workspaceSession: { ...defaults.workspaceSession, ...parsed.workspaceSession }
        }
      }
    } catch (err) {
      console.error('[persistence] Failed to load state, using defaults:', err)
    }
    return getDefaultPersistedState(homedir())
  }

  private scheduleSave(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      try {
        this.writeToDisk()
      } catch (err) {
        console.error('[persistence] Failed to write state:', err)
      }
    }, 300)
  }

  private writeToDisk(): void {
    const dir = dirname(getDataFile())
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    // Why: synchronous flushes can race the debounced writer during shutdown or
    // beforeunload persistence. A shared `.tmp` path lets one rename steal the
    // temp file from the other, which surfaces as ENOENT even though the final
    // state may already be on disk. Use a unique temp file per write so atomic
    // replaces remain race-safe across platforms.
    const tmpFile = `${getDataFile()}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8')
    renameSync(tmpFile, getDataFile())
  }

  // ── Repos ──────────────────────────────────────────────────────────

  getRepos(): Repo[] {
    return this.state.repos.map((repo) => this.hydrateRepo(repo))
  }

  getRepo(id: string): Repo | undefined {
    const repo = this.state.repos.find((r) => r.id === id)
    if (!repo) {
      return undefined
    }
    return this.hydrateRepo(repo)
  }

  addRepo(repo: Repo): void {
    this.state.repos.push(repo)
    this.scheduleSave()
  }

  removeRepo(id: string): void {
    this.state.repos = this.state.repos.filter((r) => r.id !== id)
    // Clean up worktree meta for this repo
    const prefix = `${id}::`
    for (const key of Object.keys(this.state.worktreeMeta)) {
      if (key.startsWith(prefix)) {
        delete this.state.worktreeMeta[key]
      }
    }
    this.scheduleSave()
  }

  updateRepo(
    id: string,
    updates: Partial<Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef'>>
  ): Repo | null {
    const repo = this.state.repos.find((r) => r.id === id)
    if (!repo) {
      return null
    }
    Object.assign(repo, updates)
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }

  private hydrateRepo(repo: Repo): Repo {
    const gitUsername =
      this.gitUsernameCache.get(repo.path) ??
      (() => {
        const username = getGitUsername(repo.path)
        this.gitUsernameCache.set(repo.path, username)
        return username
      })()

    return {
      ...repo,
      gitUsername,
      hookSettings: {
        ...getDefaultRepoHookSettings(),
        ...repo.hookSettings,
        scripts: {
          ...getDefaultRepoHookSettings().scripts,
          ...repo.hookSettings?.scripts
        }
      }
    }
  }

  // ── Worktree Meta ──────────────────────────────────────────────────

  getWorktreeMeta(worktreeId: string): WorktreeMeta | undefined {
    return this.state.worktreeMeta[worktreeId]
  }

  getAllWorktreeMeta(): Record<string, WorktreeMeta> {
    return this.state.worktreeMeta
  }

  setWorktreeMeta(worktreeId: string, meta: Partial<WorktreeMeta>): WorktreeMeta {
    const existing = this.state.worktreeMeta[worktreeId] || getDefaultWorktreeMeta()
    const updated = { ...existing, ...meta }
    this.state.worktreeMeta[worktreeId] = updated
    this.scheduleSave()
    return updated
  }

  removeWorktreeMeta(worktreeId: string): void {
    delete this.state.worktreeMeta[worktreeId]
    this.scheduleSave()
  }

  // ── Settings ───────────────────────────────────────────────────────

  getSettings(): GlobalSettings {
    return this.state.settings
  }

  updateSettings(updates: Partial<GlobalSettings>): GlobalSettings {
    this.state.settings = { ...this.state.settings, ...updates }
    this.scheduleSave()
    return this.state.settings
  }

  // ── UI State ───────────────────────────────────────────────────────

  getUI(): PersistedState['ui'] {
    return {
      ...getDefaultUIState(),
      ...this.state.ui,
      sortBy: normalizeSortBy(this.state.ui?.sortBy)
    }
  }

  updateUI(updates: Partial<PersistedState['ui']>): void {
    this.state.ui = {
      ...this.state.ui,
      ...updates,
      sortBy: updates.sortBy
        ? normalizeSortBy(updates.sortBy)
        : normalizeSortBy(this.state.ui?.sortBy)
    }
    this.scheduleSave()
  }

  // ── GitHub Cache ──────────────────────────────────────────────────

  getGitHubCache(): PersistedState['githubCache'] {
    return this.state.githubCache
  }

  setGitHubCache(cache: PersistedState['githubCache']): void {
    this.state.githubCache = cache
    this.scheduleSave()
  }

  // ── Workspace Session ─────────────────────────────────────────────

  getWorkspaceSession(): PersistedState['workspaceSession'] {
    return this.state.workspaceSession ?? getDefaultWorkspaceSession()
  }

  setWorkspaceSession(session: PersistedState['workspaceSession']): void {
    this.state.workspaceSession = session
    this.scheduleSave()
  }

  // ── Flush (for shutdown) ───────────────────────────────────────────

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    try {
      this.writeToDisk()
    } catch (err) {
      console.error('[persistence] Failed to flush state:', err)
    }
  }
}

function getDefaultWorktreeMeta(): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    isArchived: false,
    isUnread: false,
    sortOrder: Date.now(),
    lastActivityAt: 0
  }
}
