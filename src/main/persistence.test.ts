/* eslint-disable max-lines -- Why: this persistence suite keeps defaulting,
migration, mutation, and flush behavior in one file so schema changes are
reviewed against the full storage contract instead of being scattered. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo, TerminalTab, WorkspaceSessionState } from '../shared/types'
import { MAX_BROWSER_HISTORY_ENTRIES } from '../shared/workspace-session-browser-history'

// Shared mutable state so the electron mock can reference a per-test directory
const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
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

const makeTerminalTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'tab1',
  ptyId: 'pty1',
  worktreeId: 'repo1::/worktree',
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  ...overrides
})

function makeSessionWithTerminalBuffers(): WorkspaceSessionState {
  return {
    activeRepoId: 'local-repo',
    activeWorktreeId: 'local-repo::/local',
    activeTabId: 'local-tab',
    tabsByWorktree: {
      'local-repo::/local': [
        makeTerminalTab({
          id: 'local-tab',
          ptyId: 'local-pty',
          worktreeId: 'local-repo::/local'
        })
      ],
      'remote-repo::/remote': [
        makeTerminalTab({
          id: 'remote-tab',
          ptyId: 'remote-pty',
          worktreeId: 'remote-repo::/remote'
        })
      ]
    },
    terminalLayoutsByTabId: {
      'local-tab': {
        root: { type: 'leaf', leafId: 'leaf-local' },
        activeLeafId: 'leaf-local',
        expandedLeafId: null,
        buffersByLeafId: { 'leaf-local': 'local-scrollback' },
        ptyIdsByLeafId: { 'leaf-local': 'local-pty' }
      },
      'remote-tab': {
        root: { type: 'leaf', leafId: 'leaf-remote' },
        activeLeafId: 'leaf-remote',
        expandedLeafId: null,
        buffersByLeafId: { 'leaf-remote': 'remote-scrollback' },
        ptyIdsByLeafId: { 'leaf-remote': 'remote-pty' }
      }
    }
  }
}

function makeSessionWithBrowserHistory(count: number): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    browserUrlHistory: Array.from({ length: count }, (_, index) => ({
      url: `https://example.com/${index}`,
      normalizedUrl: `https://example.com/${index}`,
      title: `Example ${index} ${'x'.repeat(200)}`,
      lastVisitedAt: 1_700_000_000_000 - index,
      visitCount: 1
    }))
  }
}

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
    expect(settings.appFontFamily).toBe('Geist')
    expect(settings.editorAutoSave).toBe(false)
    expect(settings.editorAutoSaveDelayMs).toBe(1000)
    expect(settings.terminalFontSize).toBe(14)
    expect(settings.terminalFontWeight).toBe(500)
    expect(settings.rightSidebarOpenByDefault).toBe(true)
    expect(settings.showTasksButton).toBe(true)
    expect(settings.experimentalActivity).toBe(true)
    expect(settings.floatingTerminalEnabled).toBe(true)
    expect(settings.floatingTerminalDefaultedForAllUsers).toBe(true)
    expect(settings.notifications.customSoundPath).toBeNull()
  })

  it('returns default UI state when no data file exists', async () => {
    const store = await createStore()
    const ui = store.getUI()
    expect(ui.sidebarWidth).toBe(280)
    expect(ui.groupBy).toBe('repo')
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

  it('can clear an automation back to the project default branch', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ worktreeBaseRef: 'origin/main' }))
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      baseBranch: 'origin/release',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const updated = store.updateAutomation(automation.id, { baseBranch: null })

    expect(updated.baseBranch).toBeNull()
    store.flush()
    const persisted = readDataFile() as { automations: { baseBranch: string | null }[] }
    expect(persisted.automations[0].baseBranch).toBeNull()
  })

  it('numbers automation run titles per automation', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })

    const first = store.createAutomationRun(automation, new Date('2026-05-13T09:00:00Z').getTime())
    const duplicate = store.createAutomationRun(
      automation,
      new Date('2026-05-13T09:00:00Z').getTime()
    )
    const second = store.createAutomationRun(automation, new Date('2026-05-14T09:00:00Z').getTime())

    expect(first.title).toBe('Nightly run 1')
    expect(duplicate.id).toBe(first.id)
    expect(duplicate.title).toBe('Nightly run 1')
    expect(second.title).toBe('Nightly run 2')
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
    expect(store.getSettings().experimentalActivity).toBe(true)
    expect(store.getSettings().notifications.customSoundPath).toBeNull()
    // repos should be loaded
    expect(store.getRepos()).toHaveLength(1)
  })

  it('migrates the legacy floating terminal disabled default to enabled', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { floatingTerminalEnabled: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().floatingTerminalEnabled).toBe(true)
    expect(store.getSettings().floatingTerminalDefaultedForAllUsers).toBe(true)
  })

  it('preserves a post-migration floating terminal opt-out', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        floatingTerminalEnabled: false,
        floatingTerminalDefaultedForAllUsers: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().floatingTerminalEnabled).toBe(false)
    expect(store.getSettings().floatingTerminalDefaultedForAllUsers).toBe(true)
  })

  it('preserves custom notification sound paths from persisted settings', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        notifications: {
          customSoundPath: '/Users/kaylee/Downloads/Note_block_pling.ogg'
        }
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getSettings().notifications).toMatchObject({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: false,
      suppressWhenFocused: true,
      customSoundPath: '/Users/kaylee/Downloads/Note_block_pling.ogg'
    })
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
      appFontFamily: 'Inter',
      terminalFontSize: 16,
      terminalFontWeight: 600
    })
    expect(updated.theme).toBe('dark')
    expect(updated.editorAutoSave).toBe(true)
    expect(updated.editorAutoSaveDelayMs).toBe(1500)
    expect(updated.appFontFamily).toBe('Inter')
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
    expect(ui.groupBy).toBe('repo') // default preserved
    expect(ui.dismissedUpdateVersion).toBeNull()
  })

  it('persists updater reminder metadata in UI state', async () => {
    const store = await createStore()
    store.updateUI({ dismissedUpdateVersion: '1.0.99', lastUpdateCheckAt: 1234 })
    const ui = store.getUI()
    expect(ui.dismissedUpdateVersion).toBe('1.0.99')
    expect(ui.lastUpdateCheckAt).toBe(1234)
  })

  it('encrypts the Kagi session link on disk and decrypts it on load', async () => {
    const sessionLink = 'https://kagi.com/search?token=secret'
    const store = await createStore()

    store.updateUI({ browserKagiSessionLink: sessionLink })
    store.flush()

    const persisted = readDataFile() as { ui: { browserKagiSessionLink: string } }
    expect(persisted.ui.browserKagiSessionLink).not.toBe(sessionLink)

    const reloaded = await createStore()
    expect(reloaded.getUI().browserKagiSessionLink).toBe(sessionLink)
  })

  it('keeps plaintext Kagi session links readable for migration from older builds', async () => {
    const sessionLink = 'https://kagi.com/search?token=secret'
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { browserKagiSessionLink: sessionLink },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().browserKagiSessionLink).toBe(sessionLink)
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

  it('migrates the legacy experimentalSidekick setting to experimentalPet', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalSidekick: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().experimentalPet).toBe(true)
  })

  it('promotes legacy experimentalActivity profiles to default-on', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalActivity: false },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()

    expect(store.getSettings().experimentalActivity).toBe(true)
  })

  // ── inline-agents card-property migration ──────────────────────────
  //
  // Why: 'inline-agents' was added to DEFAULT_WORKTREE_CARD_PROPERTIES after
  // the inline agents feature shipped default-on. Existing users had
  // worktreeCardProperties persisted without the new entry, so the
  // defaults-merge in load() wouldn't reach them and the inline agent list
  // stayed hidden after upgrade. The migration appends 'inline-agents' once
  // for every user and sets a flag so a later deliberate uncheck from the
  // Workspaces view options menu sticks across restarts.

  it('adds inline-agents to persisted cardProps on first load after upgrade', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment']
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
    expect(store.getUI()._inlineAgentsDefaultedForExperiment).toBe(true)
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
  })

  it('adds inline-agents for users who launched a prior RC with the experiment off', async () => {
    // Why: the legacy flag _inlineAgentsDefaultedForExperiment was stamped
    // unconditionally on every prior load, so opt-out RC users already have
    // it set to true on disk. The default-on migration must NOT be gated on
    // that legacy flag — it must use the new _inlineAgentsDefaultedForAllUsers
    // flag instead. Without this test, the regression would re-appear if
    // anyone tried to "consolidate" the two flags.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForExperiment: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
  })

  it('respects a deliberate post-migration uncheck', async () => {
    // Why: once migrated, an empty-of-inline-agents array is treated as a
    // user choice — not a legacy pre-migration state — so we must not
    // re-add it on every subsequent launch.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForAllUsers: true
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
      settings: {},
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
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
  })

  it('preserves a deliberate uncheck from the experimental-toggle era (Case B)', async () => {
    // Why: a user who turned the experiment on and then deliberately
    // unchecked 'inline-agents' from the sidebar options menu has the same
    // on-disk shape as a never-touched user (legacy flag true, no
    // 'inline-agents' in worktreeCardProperties). The migration discriminates
    // them via the deprecated experimentalAgentDashboard value still riding
    // on disk. Without this discriminator, the deliberate uncheck would be
    // silently overridden on first load after upgrade.
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
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
  })

  it('Case B preservation is durable across restarts', async () => {
    // Why: once the new flag is stamped, the discriminator is no longer
    // consulted. Subsequent loads must leave the deliberate uncheck intact
    // even if a future settings-write code path were to strip the deprecated
    // experimentalAgentDashboard key from disk.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: true },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForExperiment: true,
        _inlineAgentsDefaultedForAllUsers: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
  })

  it('lapsed Case B (experiment off at upgrade time) re-adds inline-agents', async () => {
    // Why: documented limitation. A user who turned experiment on, unchecked,
    // then turned the experiment off again before upgrading has
    // experimentalAgentDashboard: false on disk. The discriminator only sees
    // the most recent value, so they fall into the Case C path. They re-uncheck
    // once and it sticks (new flag stamps). This test locks the limitation in
    // so a future "fix" doesn't accidentally regress something else.
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { experimentalAgentDashboard: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment'],
        _inlineAgentsDefaultedForExperiment: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
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

  it('strips local terminal scrollback buffers when setting workspace session', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'local-repo', connectionId: null }))
    store.addRepo(makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' }))

    store.setWorkspaceSession(makeSessionWithTerminalBuffers())

    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId['local-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['local-tab'].ptyIdsByLeafId).toEqual({
      'leaf-local': 'local-pty'
    })
    expect(session.terminalLayoutsByTabId['remote-tab'].buffersByLeafId).toEqual({
      'leaf-remote': 'remote-scrollback'
    })
  })

  it('caps oversized browser history when setting workspace session', async () => {
    const store = await createStore()
    const oversizedSession = makeSessionWithBrowserHistory(500)
    const oversizedBytes = Buffer.byteLength(JSON.stringify(oversizedSession))

    store.setWorkspaceSession(oversizedSession)

    const session = store.getWorkspaceSession()
    const prunedBytes = Buffer.byteLength(JSON.stringify(session))
    expect(session.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
    expect(session.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
    expect(prunedBytes).toBeLessThan(oversizedBytes / 2)
  })

  it('keeps terminal scrollback buffers when the repo catalog is not hydrated yet', async () => {
    const store = await createStore()

    store.setWorkspaceSession({
      activeRepoId: 'remote-repo',
      activeWorktreeId: 'remote-repo::/remote',
      activeTabId: 'remote-tab',
      tabsByWorktree: {
        'remote-repo::/remote': [
          makeTerminalTab({
            id: 'remote-tab',
            ptyId: 'remote-pty',
            worktreeId: 'remote-repo::/remote'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'remote-tab': {
          root: { type: 'leaf', leafId: 'leaf-remote' },
          activeLeafId: 'leaf-remote',
          expandedLeafId: null,
          buffersByLeafId: { 'leaf-remote': 'maybe-remote-scrollback' }
        }
      }
    })

    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].buffersByLeafId
    ).toEqual({
      'leaf-remote': 'maybe-remote-scrollback'
    })
  })

  it('strips legacy local terminal scrollback buffers when loading workspace session', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({ id: 'local-repo', connectionId: null }),
        makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' })
      ],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: makeSessionWithTerminalBuffers()
    })

    const store = await createStore()
    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId['local-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['remote-tab'].buffersByLeafId).toEqual({
      'leaf-remote': 'remote-scrollback'
    })
  })

  it('caps oversized legacy browser history when loading workspace session', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: makeSessionWithBrowserHistory(500)
    })

    const store = await createStore()
    const session = store.getWorkspaceSession()
    expect(session.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
    expect(session.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
  })

  it('does not restore cleared SSH bindings after a lease expired', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: 'leaf1',
      state: 'expired'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('does not let an expired lease for another tab suppress a matching pty id', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab-expired',
      leafId: 'leaf-expired',
      state: 'expired'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-live',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: 'leaf-live' },
          activeLeafId: 'leaf-live',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-live': 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-live',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: 'leaf-live' },
          activeLeafId: 'leaf-live',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('remote-pty')
    expect(session.terminalLayoutsByTabId['tab-live'].ptyIdsByLeafId).toEqual({
      'leaf-live': 'remote-pty'
    })
  })

  it('does not let an expired lease for another SSH target suppress the same tab binding', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'repo-live', connectionId: 'ssh-live' }))
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-expired',
      ptyId: 'remote-pty',
      worktreeId: 'repo-live::/wt',
      tabId: 'tab-live',
      leafId: 'leaf-live',
      state: 'expired'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-live',
      ptyId: 'remote-pty',
      worktreeId: 'repo-live::/wt',
      tabId: 'tab-live',
      leafId: 'leaf-live',
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'repo-live',
      activeWorktreeId: 'repo-live::/wt',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        'repo-live::/wt': [
          {
            id: 'tab-live',
            worktreeId: 'repo-live::/wt',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: 'leaf-live' },
          activeLeafId: 'leaf-live',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-live': 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'repo-live',
      activeWorktreeId: 'repo-live::/wt',
      activeTabId: 'tab-live',
      tabsByWorktree: {
        'repo-live::/wt': [
          {
            id: 'tab-live',
            worktreeId: 'repo-live::/wt',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-live': {
          root: { type: 'leaf', leafId: 'leaf-live' },
          activeLeafId: 'leaf-live',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree['repo-live::/wt'][0].ptyId).toBe('remote-pty')
    expect(session.terminalLayoutsByTabId['tab-live'].ptyIdsByLeafId).toEqual({
      'leaf-live': 'remote-pty'
    })
  })

  it('does not treat contextless expired leases as wildcards for contextual bindings', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      state: 'expired'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree.wt1[0].ptyId).toBe('remote-pty')
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({ leaf1: 'remote-pty' })
  })

  it('does not treat layout-level leases missing worktree context as contextual matches', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      tabId: 'tab1',
      leafId: 'leaf1',
      state: 'expired'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      leaf1: 'remote-pty'
    })
  })

  it('merges missing prior layout bindings into partial renderer snapshots', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-1',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: 'leaf1',
      state: 'detached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-2',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: 'leaf2',
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf1' },
            second: { type: 'leaf', leafId: 'leaf2' },
            ratio: 0.5
          },
          activeLeafId: 'leaf2',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty-1', leaf2: 'remote-pty-2' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf1' },
            second: { type: 'leaf', leafId: 'leaf2' },
            ratio: 0.5
          },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      leaf1: 'remote-pty-1',
      leaf2: 'remote-pty-2'
    })
  })

  it('does not restore layout bindings for leaves removed from the incoming layout', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-1',
      tabId: 'tab1',
      leafId: 'leaf1',
      state: 'detached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-2',
      tabId: 'tab1',
      leafId: 'leaf2',
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf1' },
            second: { type: 'leaf', leafId: 'leaf2' },
            ratio: 0.5
          },
          activeLeafId: 'leaf2',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty-1', leaf2: 'remote-pty-2' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      leaf1: 'remote-pty-1'
    })
  })

  it('does not restore missing layout bindings without a live SSH lease', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'local-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf1' },
            second: { type: 'leaf', leafId: 'leaf2' },
            ratio: 0.5
          },
          activeLeafId: 'leaf2',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'local-pty-1', leaf2: 'local-pty-2' }
        }
      }
    })

    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'local-pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf1' },
            second: { type: 'leaf', leafId: 'leaf2' },
            ratio: 0.5
          },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'local-pty-1' }
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      leaf1: 'local-pty-1'
    })
  })

  it('clears workspace bindings before removing SSH remote PTY leases for a target', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: 'leaf1',
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty' }
        }
      }
    })

    store.removeSshRemotePtyLeases('ssh-1')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('clears workspace bindings before removing contextless SSH remote PTY leases', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      state: 'detached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'remote-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf1' },
          activeLeafId: 'leaf1',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'remote-pty' }
        }
      }
    })

    store.removeSshRemotePtyLeases('ssh-1')

    const session = store.getWorkspaceSession()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([])
    expect(session.tabsByWorktree.wt1[0].ptyId).toBeNull()
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  it('does not revive expired leases when marking a target detached', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'live-pty',
      state: 'attached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'expired-pty',
      state: 'expired'
    })

    store.markSshRemotePtyLeases('ssh-1', 'detached')

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ptyId: 'live-pty', state: 'detached' }),
        expect.objectContaining({ ptyId: 'expired-pty', state: 'expired' })
      ])
    )
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

  // ── Rolling backups (issue #1158) ──────────────────────────────────

  describe('rolling backups', () => {
    function backupFile(index: number): string {
      return `${dataFile()}.bak.${index}`
    }

    function readBackup(index: number): { repos: Repo[] } {
      return JSON.parse(readFileSync(backupFile(index), 'utf-8'))
    }

    function advanceMockedTime(advanceFn: () => void, ms: number): void {
      vi.setSystemTime(new Date(Date.now() + ms))
      advanceFn()
    }

    it('snapshots the just-written file to .bak.0 on the very first write', async () => {
      const s = await createStore()
      s.addRepo(makeRepo())
      s.flush()
      expect(existsSync(dataFile())).toBe(true)
      expect(existsSync(backupFile(0))).toBe(true)
      expect(readBackup(0).repos.map((r) => r.id)).toEqual(['r1'])
    })

    it('rotates older .bak.0 to .bak.1 when the interval elapses', async () => {
      vi.useFakeTimers()
      try {
        const first = await createStore()
        first.addRepo(makeRepo({ id: 'r1' }))
        first.flush()
        expect((readDataFile() as { repos: Repo[] }).repos[0].id).toBe('r1')
        expect(readBackup(0).repos.map((r) => r.id)).toEqual(['r1'])

        vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))

        const second = await createStore()
        second.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))
        second.flush()

        const current = readDataFile() as { repos: Repo[] }
        expect(current.repos.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['r1', 'r2'])
        expect(readBackup(1).repos.map((r) => r.id)).toEqual(['r1'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps at most 5 rotating backups', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        for (let i = 0; i < 6; i++) {
          vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))
          const s = await createStore()
          s.addRepo(makeRepo({ id: `gen-${i}`, path: `/gen-${i}` }))
          s.flush()
        }

        for (let i = 0; i < 5; i++) {
          expect(existsSync(backupFile(i))).toBe(true)
        }
        expect(existsSync(backupFile(5))).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not rotate more than once per hour', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'after-seed' }))
        store.flush()

        const bak0After1 = readBackup(0)
        expect(bak0After1.repos.map((r) => r.id).sort()).toEqual(['after-seed', 'seed'])

        advanceMockedTime(
          () => {
            store.addRepo(makeRepo({ id: 'within-hour', path: '/within' }))
            store.flush()
          },
          5 * 60 * 1000
        )

        const bak0After2 = readBackup(0)
        expect(bak0After2.repos.map((r) => r.id).sort()).toEqual(['after-seed', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not rotate on the async write path within the 1-hour window', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first-async' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        const bak0AfterFirst = readBackup(0)
        expect(bak0AfterFirst.repos.map((r) => r.id).sort()).toEqual(['first-async', 'seed'])

        vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000))
        store.addRepo(makeRepo({ id: 'within-hour-async', path: '/within-async' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        const bak0AfterSecond = readBackup(0)
        expect(bak0AfterSecond.repos.map((r) => r.id).sort()).toEqual(['first-async', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('rotates on the async write path after the 1-hour window elapses', async () => {
      vi.useFakeTimers()
      try {
        writeDataFile({
          schemaVersion: 1,
          repos: [makeRepo({ id: 'seed' })],
          worktreeMeta: {},
          settings: {},
          ui: {},
          githubCache: { pr: {}, issue: {} },
          workspaceSession: {}
        })

        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first-async' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['first-async', 'seed'])

        vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))
        store.addRepo(makeRepo({ id: 'after-hour-async', path: '/after-async' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        expect(
          readBackup(0)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['after-hour-async', 'first-async', 'seed'])
        expect(existsSync(backupFile(1))).toBe(true)
        expect(
          readBackup(1)
            .repos.map((r) => r.id)
            .sort()
        ).toEqual(['first-async', 'seed'])
      } finally {
        vi.useRealTimers()
      }
    })

    function writeBackup(index: number, data: unknown): void {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(backupFile(index), JSON.stringify(data, null, 2), 'utf-8')
    }

    it('recovers from .bak.0 when the primary file is corrupt', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt-json', 'utf-8')
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'recovered' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['recovered'])
    })

    it('falls through to .bak.1 when both primary and .bak.0 are corrupt', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt-json', 'utf-8')
      writeFileSync(backupFile(0), '{{also-corrupt', 'utf-8')
      writeBackup(1, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'from-bak1' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['from-bak1'])
    })

    it('falls back to defaults only when every backup is also unusable', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt', 'utf-8')
      for (let i = 0; i < 5; i++) {
        writeFileSync(backupFile(i), `{{slot-${i}-corrupt`, 'utf-8')
      }

      const store = await createStore()
      expect(store.getRepos()).toEqual([])
    })

    it('uses .bak.0 even when primary file is missing entirely', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'rescued' })],
        worktreeMeta: {},
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['rescued'])
    })

    it('still recovers repos/worktrees from a backup with corrupt workspaceSession', async () => {
      mkdirSync(testState.dir, { recursive: true })
      writeFileSync(dataFile(), '{{{corrupt', 'utf-8')
      writeBackup(0, {
        schemaVersion: 1,
        repos: [makeRepo({ id: 'survives' })],
        worktreeMeta: {},
        settings: { theme: 'dark' },
        ui: {},
        githubCache: { pr: {}, issue: {} },
        workspaceSession: { activeRepoId: 12345 }
      })

      const store = await createStore()
      expect(store.getRepos().map((r) => r.id)).toEqual(['survives'])
      expect(store.getSettings().theme).toBe('dark')
    })
  })

  // ── Concurrent write serialization (issue #1158) ───────────────────

  describe('concurrent write serialization', () => {
    it('chains debounced writes via pendingWrite so they run sequentially', async () => {
      vi.useFakeTimers()
      try {
        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first' }))
        vi.advanceTimersByTime(300)
        store.addRepo(makeRepo({ id: 'second', path: '/second' }))
        vi.advanceTimersByTime(300)
        await store.waitForPendingWrite()

        const persisted = JSON.parse(readFileSync(dataFile(), 'utf-8')) as { repos: Repo[] }
        expect(persisted.repos.map((r) => r.id).sort()).toEqual(['first', 'second'])
      } finally {
        vi.useRealTimers()
      }
    })
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
          existedBeforeTelemetryRelease: false
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
      existedBeforeTelemetryRelease: false
    })
  })
})
