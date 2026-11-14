import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TerminalLayoutSnapshot } from '../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import '../../../shared/workspace-layout/stable-pane-id'
import { makeTerminalTab, TEST_LEAF_1 } from '../persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE_ID = 'repo-1::/worktree'

// Legacy tabs can exist before their first pane has been named.
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

  // A stale unmounted window write must not erase a binding main attached after load.
  it('keeps the binding when main binds first and a stale write of the loaded tab follows', async () => {
    const store = loadOldSession({ root: null, activeLeafId: null, expandedLeafId: null })
    const loaded = structuredClone(store.getWorkspaceSession())
    const leafId = loaded.terminalLayoutsByTabId['tab-1']?.activeLeafId ?? TEST_LEAF_1

    await store.persistPtyBinding({
      worktreeId: WORKTREE_ID,
      tabId: 'tab-1',
      leafId,
      ptyId: 'pty-1'
    })
    // The unmounted window republishes its original unbound layout.
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
