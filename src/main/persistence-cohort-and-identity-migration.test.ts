import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import {
  testState,
  createStore,
  dataFile,
  writeDataFile,
  makeRepo,
  makeTerminalTab,
  makeWorktreeLineage,
  makeWorkspaceLineage
} from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

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

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  // ── Telemetry cohort migration ─────────────────────────────────────
  // Why: keys on `existsSync(dataFile)`, not the new `telemetry` field, so pre-telemetry installs aren't misclassified as fresh and flipped default-on.

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
    // Load-bearing: the corrupt-file catch path keeps `fileExistedOnLoad` true so a corrupted install isn't silently opted in as fresh.
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
    expect(store.getSettings().experimentalNewWorktreeCardStyle).toBe(false)
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

describe('Store.migrateTabSwitchKeybindings', () => {
  // Freezes the tab-switch cohort on first load, keying on `fileExistedOnLoad` (not field presence) so the verdict survives later launches.

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('marks a truly fresh install done so it adopts the new defaults', async () => {
    const store = await createStore()
    expect(store.getSettings().tabSwitchKeybindingSeed).toBe('done')
  })

  it('marks a pre-existing install pending so the legacy chords get seeded', async () => {
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
    expect(store.getSettings().tabSwitchKeybindingSeed).toBe('pending')
    expect(store.getSettings().theme).toBe('dark')
  })

  it('treats a corrupt data file as a pre-existing install', async () => {
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(dataFile(), '{{{corrupt json', 'utf-8')
    const store = await createStore()
    expect(store.getSettings().tabSwitchKeybindingSeed).toBe('pending')
  })

  it('preserves an already-frozen cohort on subsequent launches', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { tabSwitchKeybindingSeed: 'done' },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    // Existing file, cohort already 'done' — must not flip to 'pending' just because the file exists.
    expect(store.getSettings().tabSwitchKeybindingSeed).toBe('done')
  })
})

describe('Store.migrateWorktreeIdentity', () => {
  const OLD = 'repo1::/ws/cunner'
  const NEW = 'repo1::/ws/worktree-creation-spinner'
  const OLD_WORKSPACE_KEY = worktreeWorkspaceKey(OLD)
  const NEW_WORKSPACE_KEY = worktreeWorkspaceKey(NEW)

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('moves meta, lineage, tabs, active pointers, and records the prior id', async () => {
    const store = await createStore()
    store.setWorktreeMeta(OLD, { displayName: 'Cunner', linkedIssue: 42 })
    store.setWorktreeLineage(OLD, makeWorktreeLineage({ worktreeId: OLD }))
    store.setWorkspaceLineage(
      makeWorkspaceLineage({
        childWorkspaceKey: OLD_WORKSPACE_KEY,
        parentWorkspaceKey: folderWorkspaceKey('folder-parent')
      })
    )
    store.setWorkspaceLineage(
      makeWorkspaceLineage({
        childWorkspaceKey: worktreeWorkspaceKey('repo1::/ws/child'),
        parentWorkspaceKey: OLD_WORKSPACE_KEY
      })
    )
    store.setWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorkspaceKey: OLD_WORKSPACE_KEY,
      activeWorktreeId: OLD,
      activeTabId: 'tab1',
      tabsByWorktree: { [OLD]: [makeTerminalTab({ id: 'tab1', worktreeId: OLD })] },
      activeWorktreeIdsOnShutdown: [OLD],
      openFilesByWorktree: {
        [OLD]: [
          { filePath: '/ws/cunner/a.ts', relativePath: 'a.ts', worktreeId: OLD, language: 'ts' }
        ]
      },
      activeFileIdByWorktree: { [OLD]: '/ws/cunner/a.ts' },
      browserTabsByWorktree: {
        [OLD]: [
          {
            id: 'browser1',
            worktreeId: OLD,
            title: 'Browser',
            url: 'about:blank',
            docLocation: {
              kind: 'workspace-doc',
              worktreeId: OLD,
              filePath: '/ws/cunner/docs/report.html'
            }
          }
        ]
      },
      browserPagesByWorkspace: {
        browser1: [
          {
            id: 'page1',
            workspaceId: 'browser1',
            worktreeId: OLD,
            docLocation: {
              kind: 'workspace-doc',
              worktreeId: OLD,
              filePath: '/ws/cunner/docs/report.html'
            }
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [OLD]: 'browser1' },
      activeTabTypeByWorktree: { [OLD]: 'browser' },
      activeTabIdByWorktree: { [OLD]: 'tab1' },
      unifiedTabs: { [OLD]: [{ id: 'unified1', worktreeId: OLD }] },
      tabGroups: {
        [OLD]: [{ id: 'group1', worktreeId: OLD, activeTabId: 'unified1', tabOrder: ['unified1'] }]
      },
      tabGroupLayouts: { [OLD]: { type: 'leaf', groupId: 'group1' } },
      activeGroupIdByWorktree: { [OLD]: 'group1' },
      lastVisitedAtByWorktreeId: { [OLD]: 123 },
      defaultTerminalTabsAppliedByWorktreeId: { [OLD]: true },
      terminalTopologyRevisionByRepoId: { repo1: 4 },
      sleepingAgentSessionsByPaneKey: {
        'tab1:leaf': {
          paneKey: 'tab1:leaf',
          tabId: 'tab1',
          worktreeId: OLD,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'Do work',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1
        }
      },
      terminalLayoutsByTabId: {}
    } as unknown as WorkspaceSessionState)
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'repo1',
        activeWorkspaceKey: OLD_WORKSPACE_KEY,
        activeWorktreeId: OLD,
        tabsByWorktree: { [OLD]: [makeTerminalTab({ id: 'host-tab', worktreeId: OLD })] },
        terminalLayoutsByTabId: {},
        terminalTopologyRevisionByRepoId: { repo1: 8 },
        terminalSurfaceTombstonesByPaneKey: {
          'host-tab:leaf': {
            worktreeId: OLD,
            parentTabId: 'host-tab',
            leafId: 'leaf',
            ptyId: 'host-pty',
            incarnationId: 'host-incarnation',
            retiredAt: 1
          }
        }
      },
      'runtime:env-a'
    )

    store.migrateWorktreeIdentity(OLD, NEW)

    expect(store.getWorktreeMeta(OLD)).toBeUndefined()
    const meta = store.getWorktreeMeta(NEW)
    expect(meta?.displayName).toBe('Cunner')
    expect(meta?.linkedIssue).toBe(42)
    expect(meta?.priorWorktreeIds).toEqual([OLD])

    expect(store.getWorktreeLineage(OLD)).toBeUndefined()
    expect(store.getWorktreeLineage(NEW)?.worktreeId).toBe(NEW)
    expect(store.getWorkspaceLineage(OLD_WORKSPACE_KEY)).toBeUndefined()
    expect(store.getWorkspaceLineage(NEW_WORKSPACE_KEY)?.childWorkspaceKey).toBe(NEW_WORKSPACE_KEY)
    expect(
      store.getWorkspaceLineage(worktreeWorkspaceKey('repo1::/ws/child'))?.parentWorkspaceKey
    ).toBe(NEW_WORKSPACE_KEY)

    // The live session's tab keeps its frozen ptyId but now belongs to the new id.
    expect(store.getWorktreeIdForTab('tab1')).toBe(NEW)
    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree[OLD]).toBeUndefined()
    expect(session.tabsByWorktree[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.activeWorkspaceKey).toBe(NEW_WORKSPACE_KEY)
    expect(session.activeWorktreeIdsOnShutdown).toEqual([NEW])
    expect(session.openFilesByWorktree?.[OLD]).toBeUndefined()
    expect(session.openFilesByWorktree?.[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.activeFileIdByWorktree?.[NEW]).toBe('/ws/cunner/a.ts')
    expect(session.browserTabsByWorktree?.[OLD]).toBeUndefined()
    expect(session.browserTabsByWorktree?.[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.browserPagesByWorkspace?.browser1?.[0]?.worktreeId).toBe(NEW)
    expect(session.browserTabsByWorktree?.[NEW]?.[0]?.docLocation).toEqual({
      kind: 'workspace-doc',
      worktreeId: NEW,
      filePath: '/ws/worktree-creation-spinner/docs/report.html'
    })
    expect(session.browserPagesByWorkspace?.browser1?.[0]?.docLocation).toEqual({
      kind: 'workspace-doc',
      worktreeId: NEW,
      filePath: '/ws/worktree-creation-spinner/docs/report.html'
    })
    expect(session.activeBrowserTabIdByWorktree?.[NEW]).toBe('browser1')
    expect(session.activeTabTypeByWorktree?.[NEW]).toBe('browser')
    expect(session.activeWorktreeId).toBe(NEW)
    expect(session.activeTabIdByWorktree?.[NEW]).toBe('tab1')
    expect(session.unifiedTabs?.[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.tabGroups?.[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(session.tabGroupLayouts?.[NEW]).toEqual({ type: 'leaf', groupId: 'group1' })
    expect(session.activeGroupIdByWorktree?.[NEW]).toBe('group1')
    expect(session.lastVisitedAtByWorktreeId?.[NEW]).toBe(123)
    expect(session.defaultTerminalTabsAppliedByWorktreeId?.[NEW]).toBe(true)
    expect(session.terminalTopologyRevisionByRepoId?.repo1).toBe(4)
    expect(session.sleepingAgentSessionsByPaneKey?.['tab1:leaf']?.worktreeId).toBe(NEW)

    const hostSession = store.getWorkspaceSession('runtime:env-a')
    expect(hostSession.tabsByWorktree[OLD]).toBeUndefined()
    expect(hostSession.tabsByWorktree[NEW]?.[0]?.worktreeId).toBe(NEW)
    expect(hostSession.activeWorkspaceKey).toBe(NEW_WORKSPACE_KEY)
    expect(hostSession.terminalTopologyRevisionByRepoId?.repo1).toBe(9)
    expect(hostSession.terminalSurfaceTombstonesByPaneKey).toEqual({})
  })

  it('rewrites parentWorktreeId back-references in other lineage entries', async () => {
    const store = await createStore()
    store.setWorktreeMeta(OLD, { displayName: 'Cunner' })
    const CHILD = 'repo1::/ws/child'
    store.setWorktreeLineage(
      CHILD,
      makeWorktreeLineage({ worktreeId: CHILD, parentWorktreeId: OLD })
    )

    store.migrateWorktreeIdentity(OLD, NEW)

    expect(store.getWorktreeLineage(CHILD)?.parentWorktreeId).toBe(NEW)
  })

  it('moves persisted mobile selections across reloads', async () => {
    const store = await createStore()
    store.setMobileClientTabSelections({
      'device-a': {
        [OLD]: { activeTabId: 'tab-1', activeGroupId: null, activeTabIdByGroupId: {} }
      }
    })

    store.migrateWorktreeIdentity(OLD, NEW)
    store.flush()

    expect(store.getMobileClientTabSelections()['device-a']?.[OLD]).toBeUndefined()
    const reloaded = await createStore()
    expect(reloaded.getMobileClientTabSelections()['device-a']?.[NEW]?.activeTabId).toBe('tab-1')
  })

  it('accumulates prior ids across chained renames', async () => {
    const store = await createStore()
    store.setWorktreeMeta(OLD, { displayName: 'Cunner' })
    store.migrateWorktreeIdentity(OLD, NEW)
    const NEWER = 'repo1::/ws/final-name'
    store.migrateWorktreeIdentity(NEW, NEWER)
    expect(store.getWorktreeMeta(NEWER)?.priorWorktreeIds).toEqual([OLD, NEW])
  })

  it('keeps the newest visit timestamp when a partial migration left both identities', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: { [OLD]: 100, [NEW]: 900 }
    })

    store.migrateWorktreeIdentity(OLD, NEW)

    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.[OLD]).toBeUndefined()
    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.[NEW]).toBe(900)
  })

  it('is a no-op when the ids match', async () => {
    const store = await createStore()
    store.setWorktreeMeta(OLD, { displayName: 'Cunner' })
    store.migrateWorktreeIdentity(OLD, OLD)
    expect(store.getWorktreeMeta(OLD)?.priorWorktreeIds).toBeUndefined()
  })
})
