import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TerminalLayoutSnapshot } from '../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { isTerminalLeafId } from '../shared/stable-pane-id'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE_ID = 'repo-1::/worktree'

// A session saved before tabs named their first pane: the tab exists, its layout has no root.
function oldSession(layout: TerminalLayoutSnapshot): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    activeTabId: 'tab-1',
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab({ id: 'tab-1', worktreeId: WORKTREE_ID, ptyId: null })]
    },
    terminalLayoutsByTabId: { 'tab-1': layout }
  }
}

function loadOldSession(layout: TerminalLayoutSnapshot) {
  writeDataFile({
    schemaVersion: 1,
    repos: [makeRepo({ id: 'repo-1', path: '/repo-1' })],
    workspaceSession: oldSession(layout)
  })
  return createStore()
}

describe('a saved layout with an empty root', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // The order that lost the binding once the save-time swap was gone: main binds first, then a
  // stale window write of the loaded (unmounted) tab arrives. Without the load repair that write
  // carries an empty root and the bound pane reads as removed.
  it('keeps the binding when main binds first and a stale write of the loaded tab follows', async () => {
    const store = loadOldSession({ root: null, activeLeafId: null, expandedLeafId: null })
    // The window's copy of the session as it was loaded.
    const loaded = structuredClone(store.getWorkspaceSession())
    // Main binds the pane the loaded layout names (any pane, if it names none).
    const leafId = loaded.terminalLayoutsByTabId['tab-1']?.activeLeafId ?? TEST_LEAF_1

    await store.persistPtyBinding({
      worktreeId: WORKTREE_ID,
      tabId: 'tab-1',
      leafId,
      ptyId: 'pty-1'
    })
    // Stale write: the window never mounted the tab, so it saves the layout as loaded, unbound.
    store.setWorkspaceSession({
      ...loaded,
      terminalLayoutsByTabId: {
        'tab-1': { ...loaded.terminalLayoutsByTabId['tab-1']!, ptyIdsByLeafId: {} }
      }
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe('pty-1')
    expect(session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({ [leafId]: 'pty-1' })
  })

  it('names a fresh pane when the old layout names none', () => {
    const layout = loadOldSession({
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    }).getWorkspaceSession().terminalLayoutsByTabId['tab-1']
    const leafId = layout?.activeLeafId ?? ''
    expect(isTerminalLeafId(leafId)).toBe(true)
    expect(layout?.root).toEqual({ type: 'leaf', leafId })
  })

  it('names the same pane on every load until something saves', async () => {
    const emptyRoot = { root: null, activeLeafId: null, expandedLeafId: null }
    const first = loadOldSession(emptyRoot).getWorkspaceSession().terminalLayoutsByTabId['tab-1']
    await closeTestStores()
    const second = loadOldSession(emptyRoot).getWorkspaceSession().terminalLayoutsByTabId['tab-1']

    expect(second?.root).toEqual(first?.root)
  })

  it('names the pane the old layout was already bound to', () => {
    const store = loadOldSession({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId['tab-1']).toEqual({
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
    })
  })
})
