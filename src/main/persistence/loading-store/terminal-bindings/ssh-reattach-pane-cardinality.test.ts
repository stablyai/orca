import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testState, createStore, makeRepo, writeDataFile } from '../../persistence-test-harness'
import { makeTerminalTab, TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'

import { getDefaultPersistedState } from '../../../../shared/constants'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE = 'repo1::/worktree'
const TAB = 'tab-1'

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

describe('STA-3077: an SSH reattach binds panes without grafting them back', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
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
})
