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

/** Reset modules and dynamically import Store so DATA_FILE picks up the current testState.dir */
async function createStore() {
  vi.resetModules()
  const { Store } = await import('./persistence')
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
    expect(settings.theme).toBe('system')
    expect(settings.editorAutoSave).toBe(false)
    expect(settings.editorAutoSaveDelayMs).toBe(1000)
    expect(settings.terminalFontSize).toBe(14)
    expect(settings.terminalFontWeight).toBe(500)
    expect(settings.rightSidebarOpenByDefault).toBe(true)
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
    expect(store.getSettings().rightSidebarOpenByDefault).toBe(true)
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
      // Now the save should have fired

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

  it('migrates persisted smart sort to recent', async () => {
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
    expect(store.getUI().sortBy).toBe('recent')
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
})
