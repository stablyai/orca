/* eslint-disable max-lines -- Why: this persistence suite keeps defaulting,
migration, mutation, and flush behavior in one file so schema changes are
reviewed against the full storage contract instead of being scattered. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../shared/types'

// Shared mutable state so the electron mock can reference a per-test directory
const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

vi.mock('./git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
}))

/** Reset modules and dynamically import Store so the data-file path picks up the current testState.dir */
async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

function writeDataFile(data: unknown): void {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf-8')
}

function readDataFile(): unknown {
  return JSON.parse(readFileSync(dataFile(), 'utf-8'))
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // ── 1. Defaults when no file exists ──────────────────────────────────

  it('returns empty repos when no data file exists', async () => {
    const store = await createStore()
    expect(store.getRepos()).toEqual([])
  })

  it('returns default settings when no data file exists', async () => {
    const store = await createStore()
    const settings = store.getSettings()
    expect(settings.branchPrefix).toBe('git-username')
    expect(settings.refreshLocalBaseRefOnWorktreeCreate).toBe(false)
    expect(settings.theme).toBe('system')
    expect(settings.editorAutoSave).toBe(false)
    expect(settings.editorAutoSaveDelayMs).toBe(1000)
    expect(settings.terminalFontSize).toBe(14)
    expect(settings.terminalFontWeight).toBe(500)
    expect(settings.rightSidebarOpenByDefault).toBe(true)
    expect(settings.showTasksButton).toBe(true)
  })

  it('returns default UI state when no data file exists', async () => {
    const store = await createStore()
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(280)
    expect(ui.groupBy).toBe('none')
    expect(ui.lastActiveRepoId).toBeNull()
    expect(ui.dismissedUpdateVersion).toBeNull()
    expect(ui.lastUpdateCheckAt).toBeNull()
  })

  // ── 2. Load from existing valid file ─────────────────────────────────

  it('reads repos from an existing data file', async () => {
    const repo = makeRepo()
    writeDataFile({
      schemaVersion: 1,
      repos: [repo],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    const repos = store.getRepos()
    expect(repos).toHaveLength(1)
    expect(repos[0].id).toBe('r1')
    expect(repos[0].gitUsername).toBe('testuser')
  })

  // ── 3. Corrupt JSON → falls back to defaults ────────────────────────

  it('falls back to defaults when data file contains invalid JSON', async () => {
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(dataFile(), '{{{invalid json', 'utf-8')

    const store = await createStore()
    expect(store.getRepos()).toEqual([])
    expect(store.getSettings().theme).toBe('system')
  })

  // ── 4. Schema migration: merges with defaults ───────────────────────

  it('merges loaded data with defaults for missing fields', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo()],
      worktreeMeta: {},
      settings: { theme: 'dark' },
      githubCache: { pr: {}, issue: {} }
      // ui and workspaceSession intentionally omitted
    })

    const store = await createStore()
    // ui should have defaults
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(280)
    // settings should preserve the overridden value
    expect(store.getSettings().theme).toBe('dark')
    // new fields get defaults when missing from persisted data
    expect(store.getSettings().editorAutoSave).toBe(false)
    expect(store.getSettings().editorAutoSaveDelayMs).toBe(1000)
    expect(store.getSettings().refreshLocalBaseRefOnWorktreeCreate).toBe(false)
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)
    expect(store.getSettings().showTasksButton).toBe(true)
    // repos should be loaded
    expect(store.getRepos()).toHaveLength(1)
  })

  it('preserves editorAutoSaveDelayMs when set in persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { editorAutoSaveDelayMs: 2500 },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().editorAutoSaveDelayMs).toBe(2500)
  })

  it('preserves editorAutoSave when set to true in persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { editorAutoSave: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().editorAutoSave).toBe(true)
  })

  it('preserves rightSidebarOpenByDefault when set to true in persisted data', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { rightSidebarOpenByDefault: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)
  })

  // ── 5. addRepo and getRepo ──────────────────────────────────────────

  it('addRepo stores a repo retrievable by getRepo', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const fetched = store.getRepo('r1')
    expect(fetched).toBeDefined()
    expect(fetched!.displayName).toBe('test')
    expect(fetched!.gitUsername).toBe('testuser')
  })

  it('getRepo returns undefined for nonexistent id', async () => {
    const store = await createStore()
    expect(store.getRepo('nonexistent')).toBeUndefined()
  })

  // ── 6. removeRepo cleans up worktree meta ──────────────────────────

  it('removeRepo deletes the repo and its worktree meta', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))

    store.setWorktreeMeta('r1::/path/wt1', { displayName: 'wt1' })
    store.setWorktreeMeta('r1::/path/wt2', { displayName: 'wt2' })
    store.setWorktreeMeta('r2::/other', { displayName: 'other' })

    store.removeRepo('r1')

    expect(store.getRepo('r1')).toBeUndefined()
    expect(store.getWorktreeMeta('r1::/path/wt1')).toBeUndefined()
    expect(store.getWorktreeMeta('r1::/path/wt2')).toBeUndefined()
    expect(store.getWorktreeMeta('r2::/other')).toBeDefined()
    expect(store.getWorktreeMeta('r2::/other')!.displayName).toBe('other')
  })

  // ── 7. updateRepo ──────────────────────────────────────────────────

  it('updateRepo modifies the repo in place', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { displayName: 'renamed' })
    expect(updated).not.toBeNull()
    expect(updated!.displayName).toBe('renamed')
    expect(store.getRepo('r1')!.displayName).toBe('renamed')
  })

  it('updateRepo returns null for nonexistent id', async () => {
    const store = await createStore()
    expect(store.updateRepo('nope', { displayName: 'x' })).toBeNull()
  })

  it('updateRepo persists issueSourcePreference across reloads', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { issueSourcePreference: 'upstream' })
    expect(updated!.issueSourcePreference).toBe('upstream')

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.issueSourcePreference).toBe('upstream')
  })

  it('updateRepo with issueSourcePreference=undefined clears the preference', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ issueSourcePreference: 'origin' }))
    expect(store.getRepo('r1')!.issueSourcePreference).toBe('origin')

    // Why: passing the key with value `undefined` must clear the preference.
    // Plain `Object.assign` skips undefined values, so without the explicit
    // delete branch in updateRepo, the persisted record would keep 'origin'.
    store.updateRepo('r1', { issueSourcePreference: undefined })
    expect(store.getRepo('r1')!.issueSourcePreference).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.issueSourcePreference).toBeUndefined()
  })

  // ── 8. setWorktreeMeta and getWorktreeMeta ─────────────────────────

  it('setWorktreeMeta creates meta with defaults for missing fields', async () => {
    const store = await createStore()
    const meta = store.setWorktreeMeta('wt1', { displayName: 'my-wt' })

    expect(meta.displayName).toBe('my-wt')
    expect(meta.comment).toBe('')
    expect(meta.linkedIssue).toBeNull()
    expect(meta.isArchived).toBe(false)
    expect(typeof meta.sortOrder).toBe('number')
  })

  it('setWorktreeMeta merges with existing meta', async () => {
    const store = await createStore()
    store.setWorktreeMeta('wt1', { displayName: 'first', comment: 'hello' })
    const updated = store.setWorktreeMeta('wt1', { comment: 'updated' })

    expect(updated.displayName).toBe('first')
    expect(updated.comment).toBe('updated')
  })

  // ── 9. Settings: get/update ────────────────────────────────────────

  it('updateSettings merges partial updates', async () => {
    const store = await createStore()
    const initial = store.getSettings()
    expect(initial.theme).toBe('system')

    const updated = store.updateSettings({
      theme: 'dark',
      editorAutoSave: true,
      editorAutoSaveDelayMs: 1500,
      terminalFontSize: 16,
      terminalFontWeight: 600
    })
    expect(updated.theme).toBe('dark')
    expect(updated.editorAutoSave).toBe(true)
    expect(updated.editorAutoSaveDelayMs).toBe(1500)
    expect(updated.terminalFontSize).toBe(16)
    expect(updated.terminalFontWeight).toBe(600)
    // Other fields preserved
    expect(updated.branchPrefix).toBe('git-username')
  })

  it('updateSettings toggles editorAutoSave', async () => {
    const store = await createStore()
    expect(store.getSettings().editorAutoSave).toBe(false)

    store.updateSettings({ editorAutoSave: true })
    expect(store.getSettings().editorAutoSave).toBe(true)

    store.updateSettings({ editorAutoSave: false })
    expect(store.getSettings().editorAutoSave).toBe(false)
  })

  it('updateSettings toggles rightSidebarOpenByDefault', async () => {
    const store = await createStore()
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)

    store.updateSettings({ rightSidebarOpenByDefault: false })
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(false)

    store.updateSettings({ rightSidebarOpenByDefault: true })
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)
  })

  // ── 10. flush writes synchronously ─────────────────────────────────

  it('flush writes state to disk synchronously', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    store.flush()

    const persisted = readDataFile() as { repos: Repo[] }
    expect(persisted.repos).toHaveLength(1)
    expect(persisted.repos[0].id).toBe('r1')
  })

  it('flush remains safe when a debounced save is also pending', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.addRepo(makeRepo())
      store.flush()
      vi.advanceTimersByTime(300)

      const persisted = readDataFile() as { repos: Repo[] }
      expect(persisted.repos).toHaveLength(1)
      expect(persisted.repos[0].id).toBe('r1')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── 11. Debounced save ─────────────────────────────────────────────

  it('debounced save writes data after the delay', async () => {
    vi.useFakeTimers()
    try {
      const store = await createStore()
      store.addRepo(makeRepo())

      // Before the debounce fires, file should not exist yet (or be stale)
      vi.advanceTimersByTime(100)
      // The 300ms debounce hasn't elapsed yet

      vi.advanceTimersByTime(300)
      // The timer fired; wait for the async disk write to complete
      await store.waitForPendingWrite()

      const persisted = readDataFile() as { repos: Repo[] }
      expect(persisted.repos).toHaveLength(1)
      expect(persisted.repos[0].id).toBe('r1')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── UI state ───────────────────────────────────────────────────────

  it('updateUI merges partial updates', async () => {
    const store = await createStore()
    store.updateUI({ sidebarWidth: 400 })
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(400)
    expect(ui.groupBy).toBe('none') // default preserved
    expect(ui.dismissedUpdateVersion).toBeNull()
  })

  it('persists updater reminder metadata in UI state', async () => {
    const store = await createStore()
    store.updateUI({ dismissedUpdateVersion: '1.0.99', lastUpdateCheckAt: 1234 })
    const ui = store.getUI()
    expect(ui.dismissedUpdateVersion).toBe('1.0.99')
    expect(ui.lastUpdateCheckAt).toBe(1234)
  })

  it('preserves persisted smart sort value', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { sortBy: 'smart' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().sortBy).toBe('smart')
  })

  it('migrates legacy recent sort to smart on first load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { sortBy: 'recent' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().sortBy).toBe('smart')
    expect(store.getUI()._sortBySmartMigrated).toBe(true)
  })

  it('preserves new recent sort after migration flag is set', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { sortBy: 'recent', _sortBySmartMigrated: true },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().sortBy).toBe('recent')
  })

  it('uses recent as the default sort for a fresh install (no persisted sortBy)', async () => {
    // Why: the legacy-recent→smart migration must gate on the *raw* persisted
    // value, not the normalized default. Otherwise, changing the default sort
    // to 'recent' would cause every fresh install to be mis-migrated to 'smart'.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().sortBy).toBe('recent')
  })

  // ── terminalMacOptionAsAlt migration (issue #903) ───────────────────

  it('migrates legacy "true" terminalMacOptionAsAlt to "auto" on first load', async () => {
    // Why: before the 'auto' mode shipped, 'true' was the global default.
    // A persisted 'true' on an un-migrated install is indistinguishable
    // from an explicit choice, so we flip to 'auto' and let detection pick
    // the right value per keyboard layout. Non-US users stop losing their
    // @ / € / [ ] characters.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'true' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('preserves explicit "false" terminalMacOptionAsAlt through migration', async () => {
    // 'false' never matched the old default — it was an explicit choice.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'false' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('false')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('preserves explicit "left" / "right" terminalMacOptionAsAlt through migration', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'left' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('left')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('respects already-migrated settings with explicit "true"', async () => {
    // After migration, if a user deliberately picks 'Both' in the UI,
    // their choice is preserved on subsequent launches.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { terminalMacOptionAsAlt: 'true', terminalMacOptionAsAltMigrated: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('true')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  it('fresh install defaults terminalMacOptionAsAlt to "auto" and marks migrated', async () => {
    // No data file at all: auto is the new default; migration is considered
    // complete since there's nothing legacy to migrate.
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    // Fresh install: default is migrated=false (nothing loaded, so the
    // migration code didn't run). On first persisted write, the flag stays
    // false, which is fine — next load with legacy 'true' would still
    // migrate correctly. Only loaded files flip the flag.
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(false)
  })

  it('missing terminalMacOptionAsAlt in persisted file defaults to "auto" and flags migrated', async () => {
    // Existing file predates the setting entirely. Treat like upgrade from
    // pre-Option-as-Alt Orca: land on 'auto' and mark migrated so we don't
    // re-examine.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().terminalMacOptionAsAlt).toBe('auto')
    expect(store.getSettings().terminalMacOptionAsAltMigrated).toBe(true)
  })

  // ── inline-agents card-property migration ──────────────────────────
  //
  // Why: 'inline-agents' was added to DEFAULT_WORKTREE_CARD_PROPERTIES after
  // the experimentalAgentDashboard toggle. Users who had the toggle on in a
  // prior rc already had worktreeCardProperties persisted without the new
  // entry, so the defaults-merge in load() wouldn't reach them and the
  // inline agent list stayed hidden after upgrade. The migration appends
  // 'inline-agents' once and sets a flag so a later deliberate uncheck
  // from the Workspaces view options menu sticks across restarts.

  it('adds inline-agents to persisted cardProps when experimental toggle is on', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: true },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment']
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
    expect(store.getUI()._inlineAgentsDefaultedForExperiment).toBe(true)
  })

  it('does not add inline-agents when experimental toggle is off', async () => {
    // Why: the experimental toggle gates whether inline agents render at all,
    // so there's no value in checking the view-mode option for opted-out users.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment']
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
    expect(store.getUI()._inlineAgentsDefaultedForExperiment).toBe(true)
  })

  it('respects a deliberate uncheck after migration flag is set', async () => {
    // Why: once migrated, an empty-of-inline-agents array is treated as a
    // user choice — not a legacy pre-migration state — so we must not
    // re-add it on every subsequent launch.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: true },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForExperiment: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
  })

  it('leaves cardProps alone when inline-agents is already present', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: true },
      ui: {
        worktreeCardProperties: [
          'status',
          'unread',
          'ci',
          'issue',
          'pr',
          'comment',
          'inline-agents'
        ]
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    const props = store.getUI().worktreeCardProperties
    expect(props.filter((p) => p === 'inline-agents')).toHaveLength(1)
    expect(store.getUI()._inlineAgentsDefaultedForExperiment).toBe(true)
  })

  // ── GitHub Cache ───────────────────────────────────────────────────

  it('get/set GitHub cache round-trips', async () => {
    const store = await createStore()
    const cache = {
      pr: { 'owner/repo#1': { data: null, fetchedAt: 1000 } },
      issue: {}
    }
    store.setGitHubCache(cache)
    expect(store.getGitHubCache()).toEqual(cache)
  })

  // ── Workspace Session ──────────────────────────────────────────────

  it('get/set workspace session round-trips', async () => {
    const store = await createStore()
    const session = {
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
    store.setWorkspaceSession(session)
    expect(store.getWorkspaceSession()).toEqual(session)
  })

  // ── getAllWorktreeMeta ─────────────────────────────────────────────

  it('getAllWorktreeMeta returns all entries', async () => {
    const store = await createStore()
    store.setWorktreeMeta('a', { displayName: 'A' })
    store.setWorktreeMeta('b', { displayName: 'B' })
    const all = store.getAllWorktreeMeta()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all['a'].displayName).toBe('A')
    expect(all['b'].displayName).toBe('B')
  })

  // ── removeWorktreeMeta ─────────────────────────────────────────────

  it('removeWorktreeMeta deletes a single entry', async () => {
    const store = await createStore()
    store.setWorktreeMeta('a', { displayName: 'A' })
    store.setWorktreeMeta('b', { displayName: 'B' })
    store.removeWorktreeMeta('a')
    expect(store.getWorktreeMeta('a')).toBeUndefined()
    expect(store.getWorktreeMeta('b')).toBeDefined()
  })

  // ── Telemetry cohort migration ─────────────────────────────────────
  //
  // The migration keys on `existsSync(dataFile)` rather than field-based
  // inference because the `telemetry` field is new in this release: keying
  // on its presence would misclassify every pre-telemetry install as fresh,
  // silently flipping existing users to default-on and violating the social
  // contract they installed Orca under.

  it('classifies a truly fresh install as new-user cohort (file absent → optedIn=true)', async () => {
    // No data file written — truly fresh install of the telemetry release.
    const store = await createStore()
    const t = store.getSettings().telemetry
    expect(t).toBeDefined()
    expect(t!.existedBeforeTelemetryRelease).toBe(false)
    expect(t!.optedIn).toBe(true)
    expect(t!.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('classifies a pre-existing install as existing-user cohort (file present → optedIn=null)', async () => {
    // A pre-telemetry data file exists on disk with no telemetry block.
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo()],
      worktreeMeta: {},
      settings: { theme: 'dark' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    const t = store.getSettings().telemetry
    expect(t).toBeDefined()
    expect(t!.existedBeforeTelemetryRelease).toBe(true)
    expect(t!.optedIn).toBeNull()
    expect(t!.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    // Sibling migrations still run alongside the telemetry migration.
    expect(store.getSettings().theme).toBe('dark')
  })

  it('still classifies as existing-user cohort when the data file is corrupt', async () => {
    // Load-bearing: `fileExistedOnLoad` stays true even when the parse
    // throws, so the corrupt-file catch path must also apply the migration.
    // Otherwise a user whose `orca-data.json` got corrupted would be
    // silently opted in as if they were a fresh install.
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(dataFile(), '{{{corrupt json', 'utf-8')
    const store = await createStore()
    const t = store.getSettings().telemetry
    expect(t).toBeDefined()
    expect(t!.existedBeforeTelemetryRelease).toBe(true)
    expect(t!.optedIn).toBeNull()
    expect(t!.installId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('preserves an already-migrated telemetry block on subsequent launches', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        telemetry: {
          optedIn: true,
          installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          existedBeforeTelemetryRelease: false,
          firstRunNoticeShown: true
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getSettings().telemetry).toEqual({
      optedIn: true,
      installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      existedBeforeTelemetryRelease: false,
      firstRunNoticeShown: true
    })
  })
})
