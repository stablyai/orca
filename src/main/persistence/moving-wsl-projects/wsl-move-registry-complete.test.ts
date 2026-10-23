import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { WSL_MOVE_RENDERER_REWRITE_STORE_IDS } from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { Store } from '../../persistence'
import { closeTestStores, createStore, testState, writeDataFile } from '../persistence-test-harness'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoverProfile } from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { tabGroup, terminalTab, unifiedTab } from '../__fixtures__/wsl-mover/wsl-mover-profile-rows'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  listWslMoveCutovers,
  wslMoveJournalDirectory,
  writeWslMoveCutover
} from './wsl-move-cutover-journal'
import {
  recordWslMoveRendererStoreRewritten,
  runGatedWslMoveDesktopRewritePass,
  runWslMoveDesktopRewritePass
} from './wsl-move-desktop-rewrite'
import { registerWslMoveDesktopRewriteRegistry } from './wsl-move-desktop-rewrite-registry'
import {
  isWslMoveDesktopRewriteRegistryComplete,
  listWslMoveDesktopRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests
} from './wsl-move-desktop-rewrite-stores'
import {
  resetWslMoveWindowWriteHoldForTests,
  isWslMoveWindowWriteHeld,
  setWslMoveReloadableWindow
} from './wsl-move-window-write-hold'
import type { WslMoveHostAutomations } from './wsl-move-host-automations-rewrite'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { runWslMoveRetentionPass } from './wsl-move-retention'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'
import { runWslMoveStartupRewrite } from './wsl-move-startup-rewrite'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../browser/browser-partition-cookie-copy', () => ({
  copyBrowserPartitionCookies: vi.fn(),
  flushBrowserPartitionCookies: vi.fn()
}))
vi.mock('../../browser/browser-session-registry', () => ({ browserSessionRegistry: {} }))
vi.mock('../../browser/browser-session-startup', () => ({ browserSessionsInitialized: vi.fn() }))
vi.mock('../../browser/browser-route-partition-binding-runtime', () => ({
  activeBrowserRoutePartitionOrcaProfileId: vi.fn(),
  currentBrowserRoutePartitionBindingStore: vi.fn()
}))
vi.mock('../../browser/browser-route-partition-storage-dependencies', () => ({
  releaseEvictedBrowserRoutePartitionStorage: vi.fn()
}))

const HOST = toRuntimeExecutionHostId('wsl:Ubuntu')
const source = wslMoverProfile('mixed-windows-wsl', 'source')
const MOVED = source.session.activeWorktreeId ?? ''
const MOVED_ON_HOST = 'repo-a::/home/dev/app'

const committedMove = (migrationId = 'move-1', carried: WorkspaceSessionState = carriedSession()) =>
  wslMoveCutoverFixture(
    migrationId,
    'destination-committed',
    {},
    { repoIds: ['repo-a'] },
    {
      version: 1,
      worktreeMeta: [],
      worktreeLineage: [],
      workspaceLineage: [],
      sparsePresets: [],
      retiredWorktreeNames: [],
      retiredWorktreeNamespaces: [],
      workspaceSession: carried
    }
  )

/** What the manifest carries for repo-a: one terminal tab, unbound. */
function carriedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [MOVED_ON_HOST]: [terminalTab('tab-1', MOVED_ON_HOST, '/home/dev/app', null)]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    },
    unifiedTabs: { [MOVED_ON_HOST]: [unifiedTab('tab-1', MOVED_ON_HOST, 'group-1')] },
    tabGroups: { [MOVED_ON_HOST]: [tabGroup('group-1', MOVED_ON_HOST, ['tab-1'])] },
    activeGroupIdByWorktree: { [MOVED_ON_HOST]: 'group-1' }
  }
}

const hostTabIds = (): string[] =>
  store.getWorkspaceSession(HOST).tabsByWorktree[MOVED_ON_HOST]?.map((tab) => tab.id) ?? []

const journal = () => listWslMoveCutovers(testState.dir)

let store: Store
let windowOpen = false
const reloads = vi.fn()
let pageLoaded: (() => void) | null = null
let enableAutomations: Mock<WslMoveHostAutomations['enable']>

/** Startup's registration, against this test's profile. */
function registerRegistry(): void {
  registerWslMoveDesktopRewriteRegistry({
    profile: store,
    orchestrationDatabasePath: join(testState.dir, 'orchestration.db'),
    hostAutomations: { enable: enableAutomations },
    browserCookies: {
      userDataPath: testState.dir,
      sessionsReady: () => true,
      orcaProfileId: () => 'orca-profile-a',
      // No environment: the cookie store records a fresh partition, the path 7f-1 tests in full.
      listEnvironments: () => [],
      listBrowserProfiles: () => [],
      resolveHostStorage: vi.fn(),
      bindHostPartition: vi.fn(),
      copyCookies: vi.fn(),
      flushCookies: vi.fn()
    }
  })
}

function recordRendererStores(migrationId = 'move-1'): void {
  for (const storeId of WSL_MOVE_RENDERER_REWRITE_STORE_IDS) {
    expect(recordWslMoveRendererStoreRewritten(testState.dir, { migrationId, storeId })).toEqual({
      recorded: true
    })
  }
}

async function retain(): Promise<void> {
  await runWslMoveRetentionPass({ userDataPath: testState.dir, store })
}

function expectFocusOnHost(): void {
  expect(store.getUI().lastActiveWorktreeId).toBe(MOVED_ON_HOST)
  const session = store.getWorkspaceSession()
  expect(session.activeWorktreeId).toBe(MOVED_ON_HOST)
  expect(session.activeWorkspaceKey).toBe(worktreeWorkspaceKey(MOVED_ON_HOST))
  expect(session.activeWorkspaceExecutionHostId).toBe(HOST)
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-registry-complete-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  writeDataFile({
    ...getDefaultPersistedState(testState.dir),
    repos: source.state.repos,
    ui: {
      ...getDefaultPersistedState(testState.dir).ui,
      ...source.ui,
      workspaceHostScope: 'local'
    },
    workspaceSession: {
      ...getDefaultWorkspaceSession(),
      ...source.session,
      activeWorkspaceKey: worktreeWorkspaceKey(MOVED),
      activeWorkspaceExecutionHostId: 'local'
    }
  })
  store = createStore()
  windowOpen = false
  reloads.mockReset()
  pageLoaded = null
  setWslMoveReloadableWindow(() =>
    windowOpen
      ? {
          isDestroyed: () => false,
          reload: reloads,
          allowUnload: () => () => {},
          onLoadedOrGone: (listener) => {
            pageLoaded = listener
            return () => {
              pageLoaded = null
            }
          }
        }
      : null
  )
  enableAutomations = vi.fn<WslMoveHostAutomations['enable']>(async () => {})
  registerRegistry()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveWindowWriteHoldForTests()
  pageLoaded?.()
  setWslMoveReloadableWindow(() => null)
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('WSL move with the complete desktop rewrite registry', () => {
  it('takes a committed move through client-rewritten to retained', async () => {
    expect(isWslMoveDesktopRewriteRegistryComplete()).toBe(true)
    seedWslMoveCutover(testState.dir, committedMove())
    loadWslMoveFence(testState.dir)

    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })
    // Every main store is in; the renderer's are still owed.
    expect(journal()[0]).toMatchObject({
      phase: 'destination-committed',
      rewrittenStores: listWslMoveDesktopRewriteStores()
        .filter((entry) => entry.side === 'main')
        .map((entry) => entry.id),
      browserCookieCopy: { outcome: 'fresh-partition' }
    })

    recordRendererStores()
    const [rewritten] = journal()
    expect(rewritten?.phase).toBe('client-rewritten')
    // Each registered store exactly once.
    expect([...(rewritten?.rewrittenStores ?? [])].sort()).toEqual(
      listWslMoveDesktopRewriteStores()
        .map((entry) => entry.id)
        .sort()
    )
    expectFocusOnHost()

    await retain()
    expect(journal()[0]?.phase).toBe('retained')
    expect(journal()[0]?.rewrittenStores).toEqual(rewritten?.rewrittenStores)
  })

  it('refuses a later move of the distro only until the earlier one is retained', async () => {
    seedWslMoveCutover(testState.dir, committedMove())
    const next = {
      ...wslMoveCutoverFixture('move-2', 'prepared', {}, { repoIds: ['repo-b'] }),
      supersedesMigrationId: 'move-1'
    }
    expect(() => writeWslMoveCutover(testState.dir, next)).toThrow('wsl_move_already_in_flight')

    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })
    recordRendererStores()
    await retain()

    writeWslMoveCutover(testState.dir, next)
    expect(journal().map((entry) => [entry.migrationId, entry.phase])).toEqual([
      ['move-1', 'retained'],
      ['move-2', 'prepared']
    ])
  })

  it('changes nothing with the gate closed', async () => {
    seedWslMoveCutover(testState.dir, committedMove())
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    const ui = store.getUI()
    const session = store.getWorkspaceSession()

    await runGatedWslMoveDesktopRewritePass({ userDataPath: testState.dir })
    await runWslMoveStartupRewrite({ userDataPath: testState.dir })
    expect(
      recordWslMoveRendererStoreRewritten(testState.dir, {
        migrationId: 'move-1',
        storeId: 'quick-open-history'
      })
    ).toEqual({ recorded: false, reason: 'gated-off' })

    expect(journal()[0]).toMatchObject({ phase: 'destination-committed', rewrittenStores: [] })
    expect(store.getUI()).toEqual(ui)
    expect(store.getWorkspaceSession()).toEqual(session)
  })

  it('changes nothing without a journal', async () => {
    const ui = store.getUI()
    const session = store.getWorkspaceSession()

    await runWslMoveStartupRewrite({ userDataPath: testState.dir })

    expect(existsSync(wslMoveJournalDirectory(testState.dir))).toBe(false)
    expect(enableAutomations).not.toHaveBeenCalled()
    expect(store.getUI()).toEqual(ui)
    expect(store.getWorkspaceSession()).toEqual(session)
  })

  it("holds an open window's saves from the rewrite until its reloaded page has loaded", async () => {
    windowOpen = true
    seedWslMoveCutover(testState.dir, committedMove())
    loadWslMoveFence(testState.dir)
    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })
    expect(isWslMoveWindowWriteHeld()).toBe(true)
    expectFocusOnHost()
    expect(hostTabIds()).toEqual(['tab-1'])
    await new Promise((resolve) => setImmediate(resolve))
    expect(reloads).toHaveBeenCalledTimes(1)

    pageLoaded?.()
    expect(isWslMoveWindowWriteHeld()).toBe(false)
    // A later pass finds every window-owned store rewritten: no second hold, no second reload.
    recordRendererStores()
    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })
    await new Promise((resolve) => setImmediate(resolve))
    expect(isWslMoveWindowWriteHeld()).toBe(false)
    expect(reloads).toHaveBeenCalledTimes(1)
  })

  it('holds and reloads nothing when no window is open', async () => {
    seedWslMoveCutover(testState.dir, committedMove())
    loadWslMoveFence(testState.dir)
    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })
    await new Promise((resolve) => setImmediate(resolve))
    expect(isWslMoveWindowWriteHeld()).toBe(false)
    expect(reloads).not.toHaveBeenCalled()
    expectFocusOnHost()
  })
})
