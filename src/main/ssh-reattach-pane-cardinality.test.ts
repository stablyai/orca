import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  testState,
  createStore,
  createStoreWithSshRemotePtyLeases,
  makeRepo,
  writeDataFile
} from './persistence/persistence-test-harness'
import {
  makeTerminalTab,
  TEST_LEAF_1,
  TEST_LEAF_2
} from './persistence/persistence-session-fixtures'

import { getDefaultPersistedState } from '../shared/constants'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const TARGET = 'ssh-1'
const WORKTREE = 'repo1::/worktree'
const TAB = 'tab-1'
const OTHER_TAB = 'tab-moved-to'

// Topology revisions distinguish a closed tab from a layout not yet published.
function sessionWithPane(args: {
  tabId: string
  leafId: string
  ptyId: string
  authoritative?: boolean
}) {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeTabId: args.tabId,
    tabsByWorktree: {
      [WORKTREE]: [makeTerminalTab({ id: args.tabId, ptyId: args.ptyId, worktreeId: WORKTREE })]
    },
    terminalLayoutsByTabId: {
      [args.tabId]: {
        root: { type: 'leaf' as const, leafId: args.leafId },
        activeLeafId: args.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [args.leafId]: args.ptyId }
      }
    },
    ...(args.authoritative === false ? {} : { terminalTopologyRevisionByRepoId: { repo1: 1 } })
  }
}

function sessionAfterClose() {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeTabId: null,
    tabsByWorktree: { [WORKTREE]: [] },
    terminalLayoutsByTabId: {},
    terminalTopologyRevisionByRepoId: { repo1: 2 }
  }
}

// Mirrors restoreReattachedPtyRuntime's relay binding.
async function relayReattachBinds(
  store: ReturnType<typeof createStore>,
  args: { tabId: string; leafId: string; ptyId: string; incarnationId?: string }
): Promise<boolean | null> {
  return await store.persistPtyBinding({
    worktreeId: WORKTREE,
    tabId: args.tabId,
    leafId: args.leafId,
    ptyId: args.ptyId,
    ...(args.incarnationId ? { incarnationId: args.incarnationId } : {}),
    mayCreate: false,
    mayReviveRetiredSurface: false
  })
}

function tabIds(store: ReturnType<typeof createStore>): string[] {
  return (store.getWorkspaceSession().tabsByWorktree?.[WORKTREE] ?? []).map((tab) => tab.id)
}

describe('STA-3077: an SSH reattach binds panes without grafting them back', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // A failed background kill leaves the lease live after the tab closes.
  it('does not resurrect a tab whose closing pty.kill failed with a transport error', async () => {
    const store = createStoreWithSshRemotePtyLeases([
      {
        targetId: TARGET,
        ptyId: 'pty-1',
        worktreeId: WORKTREE,
        tabId: TAB,
        leafId: TEST_LEAF_1,
        state: 'attached'
      }
    ])
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    store.setWorkspaceSession(sessionAfterClose())

    const bound = await relayReattachBinds(store, {
      tabId: TAB,
      leafId: TEST_LEAF_1,
      ptyId: 'pty-1',
      incarnationId: 'inc-1'
    })

    expect(bound).toBe(false)
    expect(tabIds(store)).toEqual([])
  })

  it('binds a pane that moved to another tab rather than refusing it', async () => {
    const store = await createStore()
    store.setWorkspaceSession(
      sessionWithPane({ tabId: OTHER_TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' })
    )

    const { findTerminalTabIdForLeaf } =
      await import('./persistence/terminal-topology/terminal-topology-membership')
    // Match production: resolve the live tab instead of using the lease's stale tab.
    const resolvedTabId = findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)
    expect(resolvedTabId).toBe(OTHER_TAB)

    const bound = await relayReattachBinds(store, {
      tabId: resolvedTabId!,
      leafId: TEST_LEAF_1,
      ptyId: 'pty-2',
      incarnationId: 'inc-2'
    })

    expect(bound).toBe(true)
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId?.[OTHER_TAB]?.ptyIdsByLeafId?.[TEST_LEAF_1]
    ).toBe('pty-2')
  })

  // Missing membership is not a close until the renderer publishes an authoritative layout.
  it('still binds when the session is not yet authoritative for the worktree', async () => {
    const store = await createStore()

    const bound = await store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: TEST_LEAF_1,
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      ...(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.repo1
        ? { mayCreate: false }
        : {})
    })

    expect(bound).toBe(true)
    expect(tabIds(store)).toEqual([TAB])
  })

  it('does not clear and rebind a retired surface loaded from an older profile', async () => {
    const paneKey = `${TAB}:${TEST_LEAF_1}`
    const persisted = getDefaultPersistedState(testState.dir)
    // Unregistered repo ids are swept as orphans on load.
    persisted.repos = [makeRepo({ id: 'repo1', path: '/repo1' })]
    persisted.workspaceSession = {
      ...persisted.workspaceSession,
      ...sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }),
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-1' },
      terminalSurfaceTombstonesByPaneKey: {
        [paneKey]: {
          worktreeId: WORKTREE,
          parentTabId: TAB,
          leafId: TEST_LEAF_1,
          ptyId: 'pty-1',
          incarnationId: 'inc-1',
          retiredAt: 1
        }
      }
    }
    writeDataFile(persisted)
    const store = await createStore()

    expect(store.getWorkspaceSession().terminalSurfaceTombstonesByPaneKey?.[paneKey]).toBeDefined()
    expect(
      await relayReattachBinds(store, {
        tabId: TAB,
        leafId: TEST_LEAF_1,
        ptyId: 'pty-1',
        incarnationId: 'inc-1'
      })
    ).toBe(false)
    expect(store.getWorkspaceSession().terminalSurfaceTombstonesByPaneKey?.[paneKey]).toBeDefined()
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId?.[TAB]?.ptyIdsByLeafId?.[TEST_LEAF_1]
    ).toBe('pty-1')
  })

  it('refuses to graft a second leaf into a tab the reattach does not already own', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))

    const bound = await relayReattachBinds(store, {
      tabId: TAB,
      leafId: TEST_LEAF_2,
      ptyId: 'pty-2',
      incarnationId: 'inc-2'
    })

    expect(bound).toBe(false)
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId?.[TAB]
    expect(layout?.ptyIdsByLeafId?.[TEST_LEAF_2]).toBeUndefined()
    expect(layout?.root).toEqual({ type: 'leaf', leafId: TEST_LEAF_1 })
  })

  // Session writes consume surface tombstones; the topology revision must carry close authority.
  it('treats a raised topology revision as the authority that makes absence a close', async () => {
    const store = await createStore()
    store.setWorkspaceSession(sessionWithPane({ tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' }))
    store.setWorkspaceSession(sessionAfterClose())

    const session = store.getWorkspaceSession()
    expect(session.terminalTopologyRevisionByRepoId?.repo1).toBeGreaterThan(0)
    expect(session.terminalSurfaceTombstonesByPaneKey ?? {}).toEqual({})
    expect(
      await relayReattachBinds(store, { tabId: TAB, leafId: TEST_LEAF_1, ptyId: 'pty-1' })
    ).toBe(false)
  })
})
