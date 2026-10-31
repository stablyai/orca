import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Tab } from '../../../shared/tab-types'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Store } from '../../persistence'
import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { wslMoverProfile } from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { tabGroup, terminalTab, unifiedTab } from '../__fixtures__/wsl-mover/wsl-mover-profile-rows'
import { listWslMoveCutovers, wslMoveJournalDirectory } from './wsl-move-cutover-journal'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import {
  listWslMoveDesktopRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests
} from './wsl-move-desktop-rewrite-stores'
import { registerWslMoveMainRewriteStores } from './wsl-move-main-rewrite-stores'
import { findCrossHostPaneTabIds } from '../restoring-sessions/cross-host-pane-tab-ids'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const HOST = toRuntimeExecutionHostId('wsl:Ubuntu')
const source = wslMoverProfile('mixed-windows-wsl', 'source')
const destination = wslMoverProfile('mixed-windows-wsl', 'destination')
const MOVED = source.session.activeWorktreeId ?? ''
const MOVED_ON_HOST = 'repo-a::/home/dev/app'
const STORE_IDS = ['ui-routing', 'session-globals', 'host-session-seed']

/** What a real manifest carries for repo-a: host ids, its rows only, no PTY ids (validated). */
function carriedSession(): WorkspaceSessionState {
  const chat: Tab = {
    ...unifiedTab('chat-1', MOVED_ON_HOST, 'group-1'),
    contentType: 'agent-session'
  }
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
    unifiedTabs: {
      [MOVED_ON_HOST]: [unifiedTab('tab-1', MOVED_ON_HOST, 'group-1'), chat]
    },
    tabGroups: {
      [MOVED_ON_HOST]: [tabGroup('group-1', MOVED_ON_HOST, ['tab-1', 'chat-1'])]
    },
    activeGroupIdByWorktree: { [MOVED_ON_HOST]: 'group-1' }
  }
}

function committedMove(rewrittenStores: string[] = []) {
  return wslMoveCutoverFixture(
    'move-1',
    'destination-committed',
    { rewrittenStores },
    { repoIds: ['repo-a'] },
    {
      version: 1,
      worktreeMeta: [],
      worktreeLineage: [],
      workspaceLineage: [],
      sparsePresets: [],
      retiredWorktreeNames: [],
      retiredWorktreeNamespaces: [],
      workspaceSession: carriedSession()
    }
  )
}

function persisted(): PersistedState {
  return JSON.parse(readPersistedStateJson())
}

let store: Store
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-main-stores-'))
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
      activeWorkspaceExecutionHostId: 'local'
    }
  })
  store = createStore()
  registerWslMoveMainRewriteStores(store)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('WSL move main rewrite stores', () => {
  it('registers the three main stores in run order', () => {
    expect(listWslMoveDesktopRewriteStores().map((entry) => [entry.id, entry.side])).toEqual(
      STORE_IDS.map((id) => [id, 'main'])
    )
  })

  it('rewrites and records each store on disk, then finishes the rewrite', async () => {
    seedWslMoveCutover(testState.dir, committedMove())
    loadWslMoveFence(testState.dir)

    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })

    const [record] = listWslMoveCutovers(testState.dir)
    expect(record?.rewrittenStores).toEqual(STORE_IDS)
    // Only these three are registered here, so the ledger is complete.
    expect(record?.phase).toBe('client-rewritten')
    expect(record?.seededHostWorkspaceIds).toEqual([MOVED_ON_HOST])
    // Read back from the profile database: each store's flush made its write durable.
    const saved = persisted()
    expect(saved.ui.lastActiveWorktreeId).toBe(MOVED_ON_HOST)
    // The local forms stay beside the host's, for a downgrade.
    expect(saved.ui.explorerDisplayRootByWorktree).toEqual({
      ...source.ui?.explorerDisplayRootByWorktree,
      ...destination.ui?.explorerDisplayRootByWorktree
    })
    expect(saved.ui.manualRepoOrder).toEqual([
      { hostId: 'local', repoId: 'repo-a' },
      { hostId: HOST, repoId: 'repo-a' }
    ])
    expect(saved.ui.visibleWorkspaceHostIds).toEqual(['local', HOST])
    expect(saved.workspaceSession.activeWorktreeId).toBe(MOVED_ON_HOST)
    expect(saved.workspaceSession.activeWorkspaceExecutionHostId).toBe(HOST)
    const hostSession = saved.workspaceSessionsByHostId?.[HOST]
    expect(hostSession?.tabsByWorktree[MOVED_ON_HOST]?.map((tab) => [tab.id, tab.ptyId])).toEqual([
      ['tab-1', null]
    ])
    // The chat stays listed on this computer's retained entry, not on the host.
    expect(hostSession?.unifiedTabs?.[MOVED_ON_HOST]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(hostSession?.tabGroups?.[MOVED_ON_HOST]?.[0]?.tabOrder).toEqual(['tab-1'])
    // The repo that stays on this computer keeps its local rows and gets no host rows.
    expect(hostSession?.tabsByWorktree['repo-b::/home/dev/lib']).toBeUndefined()
    expect(saved.workspaceSession.tabsByWorktree[MOVED]?.map((tab) => tab.id)).toEqual(['tab-1'])
    // Both partitions hold tab-1, but the local one is the moved project's dormant copy.
    expect(saved.workspaceSession.terminalLayoutsByTabId['tab-1']).toBeDefined()
    expect(hostSession?.terminalLayoutsByTabId['tab-1']).toBeDefined()
    expect(findCrossHostPaneTabIds(saved)).toEqual(new Set())
  })

  it('re-runs a store whose ledger entry a crash lost, changing nothing', async () => {
    seedWslMoveCutover(testState.dir, committedMove())
    loadWslMoveFence(testState.dir)
    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })
    const before = persisted()
    // As if the process died after host-session-seed flushed but before its ledger append.
    resetWslMoveDesktopRewriteStoresForTests()
    rmSync(wslMoveJournalDirectory(testState.dir), {
      recursive: true,
      force: true
    })
    seedWslMoveCutover(testState.dir, committedMove(['ui-routing', 'session-globals']))
    registerWslMoveMainRewriteStores(store)
    const seed = vi.spyOn(store, 'setWorkspaceSession')

    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })

    expect(seed).not.toHaveBeenCalled()
    expect(listWslMoveCutovers(testState.dir)[0]?.rewrittenStores).toEqual(STORE_IDS)
    const after = persisted()
    expect(after.ui).toEqual(before.ui)
    expect(after.workspaceSession).toEqual(before.workspaceSession)
    expect(after.workspaceSessionsByHostId).toEqual(before.workspaceSessionsByHostId)
  })

  it('never re-seeds a tab the user closed after a seed whose flush timed out', async () => {
    seedWslMoveCutover(testState.dir, committedMove())
    loadWslMoveFence(testState.dir)
    const flush = store.flushPendingOrThrowAsync.bind(store)
    const hangThirdFlush = vi
      .spyOn(store, 'flushPendingOrThrowAsync')
      .mockImplementationOnce(flush)
      .mockImplementationOnce(flush)
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    // Long enough that only the hung flush runs out, even on a loaded machine.
    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir, storeTimeoutMs: 2_000 })

    const afterTimeout = listWslMoveCutovers(testState.dir)[0]
    expect(afterTimeout?.rewrittenStores).toEqual(['ui-routing', 'session-globals'])
    expect(afterTimeout?.seededHostWorkspaceIds).toEqual([MOVED_ON_HOST])
    // The user closes the seeded tabs before the next pass.
    store.setWorkspaceSession(getDefaultWorkspaceSession(), HOST)
    hangThirdFlush.mockRestore()
    const seed = vi.spyOn(store, 'setWorkspaceSession')

    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })

    expect(seed).not.toHaveBeenCalled()
    expect(listWslMoveCutovers(testState.dir)[0]?.rewrittenStores).toEqual(STORE_IDS)
    expect(store.getWorkspaceSession(HOST).tabsByWorktree[MOVED_ON_HOST]).toBeUndefined()
  })

  it('does nothing for a move that has not committed', async () => {
    seedWslMoveCutover(testState.dir, {
      ...committedMove(),
      phase: 'blobs-transferred'
    })
    const ui = store.getUI()

    await runWslMoveDesktopRewritePass({ userDataPath: testState.dir })

    expect(store.getUI()).toEqual(ui)
    expect(store.getWorkspaceSession(HOST).tabsByWorktree).toEqual({})
  })
})
