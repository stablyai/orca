/* eslint-disable max-lines -- Why: persistence keeps schema defaults, migration,
load/save, and flush logic in one file so the full storage contract is reviewable
as a unit instead of being scattered across modules. */
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'fs'
import { writeFile, rename, mkdir, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'node:crypto'
import type {
  PersistedState,
  Repo,
  SparsePreset,
  WorktreeMeta,
  GlobalSettings
} from '../shared/types'
import type { SshTarget } from '../shared/ssh-types'
import { isFolderRepo } from '../shared/repo-kind'
import { getGitUsername } from './git/repo'
import {
  getDefaultPersistedState,
  getDefaultNotificationSettings,
  getDefaultUIState,
  getDefaultRepoHookSettings,
  getDefaultWorkspaceSession
} from '../shared/constants'
import { parseWorkspaceSession } from '../shared/workspace-session-schema'

function encrypt(plaintext: string): string {
  if (!plaintext || !safeStorage.isEncryptionAvailable()) {
    return plaintext
  }
  try {
    return safeStorage.encryptString(plaintext).toString('base64')
  } catch (err) {
    console.error('[persistence] Encryption failed:', err)
    return plaintext
  }
}

function decrypt(ciphertext: string): string {
  if (!ciphertext || !safeStorage.isEncryptionAvailable()) {
    return ciphertext
  }
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
  } catch {
    // Why: if decryption fails, it likely means the value was stored as
    // plaintext (pre-encryption build) or the OS keychain changed. Fall
    // back to the raw string so users don't lose their cookie after upgrade.
    console.warn(
      '[persistence] safeStorage decryption failed — returning ciphertext as-is. Possible keychain reset.'
    )
    return ciphertext
  }
}

// Why: the data-file path must not be a module-level constant. Module-level
// code runs at import time — before configureDevUserDataPath() redirects the
// userData path in index.ts — so a constant would capture the default (non-dev)
// path, causing dev and production instances to share the same file and silently
// overwrite each other.
//
// It also must not be resolved lazily on every call, because app.setName('Orca')
// runs before the Store constructor and would change the resolved path from
// lowercase 'orca' to uppercase 'Orca'. On case-sensitive filesystems (Linux)
// this would look in the wrong directory and lose existing user data.
//
// Solution: index.ts calls initDataPath() right after configureDevUserDataPath()
// but before app.setName(), capturing the correct path at the right moment.
let _dataFile: string | null = null

export function initDataPath(): void {
  _dataFile = join(app.getPath('userData'), 'orca-data.json')
}

function getDataFile(): string {
  if (!_dataFile) {
    // Safety fallback — should not be hit in normal startup.
    _dataFile = join(app.getPath('userData'), 'orca-data.json')
  }
  return _dataFile
}

function normalizeSortBy(sortBy: unknown): 'name' | 'smart' | 'recent' | 'repo' {
  if (sortBy === 'smart' || sortBy === 'recent' || sortBy === 'repo' || sortBy === 'name') {
    return sortBy
  }
  return getDefaultUIState().sortBy
}

// Why: old persisted targets predate configHost. Default to label-based lookup
// so imported SSH aliases keep resolving through ssh -G after upgrade.
function normalizeSshTarget(t: SshTarget): SshTarget {
  return { ...t, configHost: t.configHost ?? t.label ?? t.host }
}

export class Store {
  private state: PersistedState
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private writeGeneration = 0
  private gitUsernameCache = new Map<string, string>()

  constructor() {
    this.state = this.load()
  }

  private load(): PersistedState {
    // Capture once, at the top: this is the unambiguous "has the user run
    // Orca before?" signal used by the telemetry cohort migration below.
    // Field-based inference (e.g., `settings.telemetry` presence) does not
    // work on the telemetry release itself — `telemetry` is new here, so it
    // would be absent on every pre-telemetry install and misclassify existing
    // users as fresh, flipping them to default-on in violation of the
    // social contract we installed them under.
    const dataFile = getDataFile()
    const fileExistedOnLoad = existsSync(dataFile)

    let result: PersistedState | null = null
    try {
      if (fileExistedOnLoad) {
        const raw = readFileSync(dataFile, 'utf-8')
        const parsed = JSON.parse(raw) as PersistedState

        // Why: opencodeSessionCookie is stored encrypted on disk via safeStorage.
        // Decrypt at the load boundary so the rest of the app sees plaintext.
        if (parsed.settings?.opencodeSessionCookie) {
          parsed.settings.opencodeSessionCookie = decrypt(parsed.settings.opencodeSessionCookie)
        }

        // Merge with defaults in case new fields were added
        const defaults = getDefaultPersistedState(homedir())
        // Why: before the layout-aware 'auto' mode shipped (issue #903),
        // terminalMacOptionAsAlt defaulted to 'true' globally. That silently
        // broke Option-layer characters (@ on Turkish via Option+Q, @ on
        // German via Option+L, € on French via Option+E) for non-US users.
        // We can't distinguish a persisted 'true' that the user chose
        // explicitly from one they inherited from the old default — so on
        // first launch after upgrade, flip 'true' back to 'auto' and let
        // the renderer's keyboard-layout probe pick the right value per
        // layout. US users land on 'true' via detection (no change); non-US
        // users land on 'false' (correct). 'false'/'left'/'right' are
        // definitionally explicit choices (they never matched the old
        // default) so we carry those forward unchanged. The migrated flag
        // guards against re-running this on subsequent launches.
        const rawOptionAsAlt = parsed.settings?.terminalMacOptionAsAlt
        const alreadyMigrated = parsed.settings?.terminalMacOptionAsAltMigrated === true
        const migratedOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right' = alreadyMigrated
          ? (rawOptionAsAlt ?? 'auto')
          : rawOptionAsAlt === undefined || rawOptionAsAlt === 'true'
            ? 'auto'
            : rawOptionAsAlt
        result = {
          ...defaults,
          ...parsed,
          settings: {
            ...defaults.settings,
            ...parsed.settings,
            terminalMacOptionAsAlt: migratedOptionAsAlt,
            terminalMacOptionAsAltMigrated: true,
            notifications: {
              ...getDefaultNotificationSettings(),
              ...parsed.settings?.notifications
            }
          },
          // Why: 'recent' used to mean the weighted smart sort. One-shot
          // migration moves it to 'smart'; the flag prevents re-firing after
          // a user intentionally selects the new last-activity 'recent' sort.
          // Gate on the *raw* persisted value, not the normalized one: the
          // default sortBy is now 'recent', so a fresh install with no
          // persisted sortBy would otherwise be mis-migrated to 'smart'.
          ui: (() => {
            const rawSort = parsed.ui?.sortBy
            const sort = normalizeSortBy(rawSort)
            const migrate = !parsed.ui?._sortBySmartMigrated && rawSort === 'recent'
            // Why: the 'inline-agents' card property was added after the
            // experimentalAgentDashboard toggle. Users who had the toggle on
            // in a prior rc already had worktreeCardProperties persisted
            // without the new entry, so a simple defaults merge wouldn't
            // reach them and the inline agent list stayed hidden after
            // upgrade. One-shot append 'inline-agents' to their persisted
            // array when the experimental toggle is true; the flag prevents
            // re-firing so a deliberate uncheck from the Workspaces view
            // options menu sticks across restarts.
            // The flag is stamped on every successful load — including when
            // the experiment is off — so that a later flip-on is handled by
            // the renderer's ExperimentalPane handler rather than re-firing
            // this migration.
            const rawCardProps = parsed.ui?.worktreeCardProperties
            const inlineAgentsMigrated = parsed.ui?._inlineAgentsDefaultedForExperiment === true
            const experimentOn = parsed.settings?.experimentalAgentDashboard === true
            const needsInlineAgentsMigration =
              !inlineAgentsMigrated &&
              experimentOn &&
              Array.isArray(rawCardProps) &&
              !rawCardProps.includes('inline-agents')
            const migratedCardProps =
              needsInlineAgentsMigration && Array.isArray(rawCardProps)
                ? [...rawCardProps, 'inline-agents' as const]
                : undefined
            return {
              ...defaults.ui,
              ...parsed.ui,
              sortBy: migrate ? ('smart' as const) : sort,
              _sortBySmartMigrated: true,
              ...(migratedCardProps !== undefined
                ? { worktreeCardProperties: migratedCardProps }
                : {}),
              _inlineAgentsDefaultedForExperiment: true
            }
          })(),
          // Why: the workspace session is the most volatile persisted surface
          // (schema evolves per release, daemon session IDs embedded in it).
          // Zod-validate at the read boundary so a field-type flip from an
          // older build — or a truncated write from a crash — gets rejected
          // cleanly instead of poisoning Zustand state and crashing the
          // renderer on mount. On validation failure, fall back to defaults
          // and log; a corrupt session file shouldn't trap the user out.
          workspaceSession: (() => {
            if (parsed.workspaceSession === undefined) {
              return defaults.workspaceSession
            }
            const result = parseWorkspaceSession(parsed.workspaceSession)
            if (!result.ok) {
              console.error(
                '[persistence] Corrupt workspace session, using defaults:',
                result.error
              )
              return defaults.workspaceSession
            }
            return { ...defaults.workspaceSession, ...result.value }
          })(),
          sshTargets: (parsed.sshTargets ?? []).map(normalizeSshTarget)
        }
      }
    } catch (err) {
      console.error('[persistence] Failed to load state, using defaults:', err)
    }

    // Corrupt-file catch path and "no file on disk" path converge here. The
    // telemetry migration below runs on whichever branch produced `result`,
    // because a user whose `orca-data.json` got corrupted is not a fresh
    // install of the telemetry release — they still count as existing and
    // must see the opt-in banner, not the default-on toast.
    if (result === null) {
      result = getDefaultPersistedState(homedir())
    }

    return this.migrateTelemetry(result, fileExistedOnLoad)
  }

  // One-shot telemetry cohort migration. Runs on every `load()` but is a
  // no-op once `existedBeforeTelemetryRelease` is set, so subsequent launches
  // pay only the property lookup. Populates:
  //   - `existedBeforeTelemetryRelease` — cohort discriminator (drives the
  //     first-launch toast vs. banner in PR 3).
  //   - `optedIn` — new users start opted in; existing users are `null` until
  //     the banner resolves (the consent resolver returns `pending_banner`
  //     until then, so nothing transmits).
  //   - `installId` — anonymous UUID v4. Stable across launches; regenerable
  //     from the Privacy pane (PR 3).
  private migrateTelemetry(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.telemetry
    // Why: the one-shot is complete only when all three invariants hold.
    // Keying on `existedBeforeTelemetryRelease` alone would let a partially-
    // written telemetry block (crash mid-save, hand-edit, future bug) short-
    // circuit migration and leave `installId` undefined or `optedIn` wiped.
    if (
      typeof existing?.existedBeforeTelemetryRelease === 'boolean' &&
      typeof existing.installId === 'string' &&
      existing.installId.length > 0 &&
      (existing.optedIn === true || existing.optedIn === false || existing.optedIn === null)
    ) {
      return state
    }
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          ...existing,
          existedBeforeTelemetryRelease:
            typeof existing?.existedBeforeTelemetryRelease === 'boolean'
              ? existing.existedBeforeTelemetryRelease
              : fileExistedOnLoad,
          // Why: preserve an explicit opt-in/out if the user has ever resolved
          // it. Only fall back to the cohort default (new users: on; existing
          // users: undecided until the first-launch banner resolves) when
          // optedIn is truly unset (undefined), never when it is `false`.
          optedIn:
            existing?.optedIn === true || existing?.optedIn === false || existing?.optedIn === null
              ? existing.optedIn
              : fileExistedOnLoad
                ? null
                : true,
          installId:
            typeof existing?.installId === 'string' && existing.installId.length > 0
              ? existing.installId
              : randomUUID()
        }
      }
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.pendingWrite = this.writeToDiskAsync()
        .catch((err) => {
          console.error('[persistence] Failed to write state:', err)
        })
        .finally(() => {
          this.pendingWrite = null
        })
    }, 300)
  }

  /** Wait for any in-flight async disk write to complete. Used in tests. */
  async waitForPendingWrite(): Promise<void> {
    if (this.pendingWrite) {
      await this.pendingWrite
    }
  }

  // Why: async writes avoid blocking the main Electron thread on every
  // debounced save (every 300ms during active use).
  private async writeToDiskAsync(): Promise<void> {
    const gen = this.writeGeneration
    const dataFile = getDataFile()
    const dir = dirname(dataFile)
    await mkdir(dir, { recursive: true }).catch(() => {})
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

    // Why: opencodeSessionCookie must be encrypted on disk. Clone state so
    // the in-memory this.state stays plaintext for the rest of the app.
    const stateToSave = {
      ...this.state,
      settings: {
        ...this.state.settings,
        opencodeSessionCookie: encrypt(this.state.settings.opencodeSessionCookie)
      }
    }

    // Why: wrap write+rename in try/finally-on-error so any failure (ENOSPC,
    // ENFILE, EIO, permission) removes the tmp file rather than leaving a
    // multi-megabyte orphan behind. Successful rename consumes the tmp file.
    let renamed = false
    try {
      await writeFile(tmpFile, JSON.stringify(stateToSave, null, 2), 'utf-8')
      // Why: if flush() ran while this async write was in-flight, it bumped
      // writeGeneration and already wrote the latest state synchronously.
      // Renaming this stale tmp file would overwrite the fresh data.
      if (this.writeGeneration !== gen) {
        return
      }
      await rename(tmpFile, dataFile)
      renamed = true
    } finally {
      if (!renamed) {
        await rm(tmpFile).catch(() => {})
      }
    }
  }

  // Why: synchronous variant kept only for flush() at shutdown, where the
  // process may exit before an async write completes.
  private writeToDiskSync(): void {
    const dataFile = getDataFile()
    const dir = dirname(dataFile)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`

    // Why: opencodeSessionCookie must be encrypted on disk. Clone state so
    // the in-memory this.state stays plaintext for the rest of the app.
    const stateToSave = {
      ...this.state,
      settings: {
        ...this.state.settings,
        opencodeSessionCookie: encrypt(this.state.settings.opencodeSessionCookie)
      }
    }

    // Why: mirror the async path — on any failure between writeFileSync and
    // renameSync, remove the tmp file so crashes during shutdown don't leak
    // orphans into userData.
    let renamed = false
    try {
      writeFileSync(tmpFile, JSON.stringify(stateToSave, null, 2), 'utf-8')
      renameSync(tmpFile, dataFile)
      renamed = true
    } finally {
      if (!renamed) {
        try {
          unlinkSync(tmpFile)
        } catch {
          // Best-effort cleanup; the write already failed, swallow secondary error.
        }
      }
    }
  }

  // ── Repos ──────────────────────────────────────────────────────────

  getRepos(): Repo[] {
    return this.state.repos.map((repo) => this.hydrateRepo(repo))
  }

  getRepo(id: string): Repo | undefined {
    const repo = this.state.repos.find((r) => r.id === id)
    return repo ? this.hydrateRepo(repo) : undefined
  }

  addRepo(repo: Repo): void {
    this.state.repos.push(repo)
    this.scheduleSave()
  }

  removeRepo(id: string): void {
    this.state.repos = this.state.repos.filter((r) => r.id !== id)
    // Why: presets are repo-scoped, so removing the repo means the presets
    // can never be referenced again — drop them with the parent.
    delete this.state.sparsePresetsByRepo[id]
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
    updates: Partial<
      Pick<
        Repo,
        | 'displayName'
        | 'badgeColor'
        | 'hookSettings'
        | 'worktreeBaseRef'
        | 'kind'
        | 'issueSourcePreference'
      >
    >
  ): Repo | null {
    const repo = this.state.repos.find((r) => r.id === id)
    if (!repo) {
      return null
    }
    // Why: `issueSourcePreference === undefined` in the patch means "reset to
    // auto" (and the persisted record should drop the key, not preserve a
    // stale explicit value via Object.assign's skip-on-undefined behavior).
    // Without this delete branch, toggling explicit → auto would silently
    // leave the old preference in place on disk.
    if ('issueSourcePreference' in updates && updates.issueSourcePreference === undefined) {
      delete repo.issueSourcePreference
      const { issueSourcePreference: _drop, ...rest } = updates
      Object.assign(repo, rest)
    } else {
      Object.assign(repo, updates)
    }
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }

  private hydrateRepo(repo: Repo): Repo {
    const gitUsername = isFolderRepo(repo)
      ? ''
      : (this.gitUsernameCache.get(repo.path) ??
        (() => {
          const username = getGitUsername(repo.path)
          this.gitUsernameCache.set(repo.path, username)
          return username
        })())

    return {
      ...repo,
      kind: isFolderRepo(repo) ? 'folder' : 'git',
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

  // ── Sparse Presets ─────────────────────────────────────────────────

  getSparsePresets(repoId: string): SparsePreset[] {
    return [...(this.state.sparsePresetsByRepo[repoId] ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  }

  saveSparsePreset(preset: SparsePreset): SparsePreset {
    const existing = this.state.sparsePresetsByRepo[preset.repoId] ?? []
    const index = existing.findIndex((entry) => entry.id === preset.id)
    this.state.sparsePresetsByRepo[preset.repoId] =
      index === -1
        ? [...existing, preset]
        : existing.map((entry, i) => (i === index ? preset : entry))
    this.scheduleSave()
    return preset
  }

  removeSparsePreset(repoId: string, presetId: string): void {
    const existing = this.state.sparsePresetsByRepo[repoId] ?? []
    this.state.sparsePresetsByRepo[repoId] = existing.filter((entry) => entry.id !== presetId)
    this.scheduleSave()
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
    // Why: `telemetry` is deep-merged for the same reason `notifications` is —
    // partial updates from the Privacy pane / consent flow (e.g., flipping
    // only `optedIn`) must not clobber sibling fields like `installId` or
    // `existedBeforeTelemetryRelease`. The field is optional, so we only
    // synthesize a `telemetry` key on the result when at least one side has
    // one.
    const mergedTelemetry =
      updates.telemetry !== undefined
        ? { ...this.state.settings.telemetry, ...updates.telemetry }
        : this.state.settings.telemetry
    this.state.settings = {
      ...this.state.settings,
      ...updates,
      notifications: {
        ...this.state.settings.notifications,
        ...updates.notifications
      },
      ...(mergedTelemetry !== undefined ? { telemetry: mergedTelemetry } : {})
    }
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

  // ── SSH Targets ────────────────────────────────────────────────────

  getSshTargets(): SshTarget[] {
    return (this.state.sshTargets ?? []).map(normalizeSshTarget)
  }

  getSshTarget(id: string): SshTarget | undefined {
    const target = this.state.sshTargets?.find((t) => t.id === id)
    return target ? normalizeSshTarget(target) : undefined
  }

  addSshTarget(target: SshTarget): void {
    this.state.sshTargets ??= []
    this.state.sshTargets.push(normalizeSshTarget(target))
    this.scheduleSave()
  }

  updateSshTarget(id: string, updates: Partial<Omit<SshTarget, 'id'>>): SshTarget | null {
    const target = this.state.sshTargets?.find((t) => t.id === id)
    if (!target) {
      return null
    }
    Object.assign(target, updates, normalizeSshTarget({ ...target, ...updates }))
    this.scheduleSave()
    return { ...target }
  }

  removeSshTarget(id: string): void {
    if (!this.state.sshTargets) {
      return
    }
    this.state.sshTargets = this.state.sshTargets.filter((t) => t.id !== id)
    this.scheduleSave()
  }

  // ── Flush (for shutdown) ───────────────────────────────────────────

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    // Why: bump writeGeneration so any in-flight async writeToDiskAsync skips
    // its rename, preventing a stale snapshot from overwriting this sync write.
    this.writeGeneration++
    this.pendingWrite = null
    try {
      this.writeToDiskSync()
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
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: Date.now(),
    lastActivityAt: 0
  }
}
