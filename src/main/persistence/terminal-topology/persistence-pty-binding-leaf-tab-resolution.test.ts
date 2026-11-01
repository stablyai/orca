import { closeTestStores, testState, createStore } from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { findTerminalTabIdForLeaf } from './terminal-topology-membership'

import { makeTerminalTab, TEST_LEAF_1, TEST_LEAF_2 } from '../persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

describe('findTerminalTabIdForLeaf after persistPtyBinding grafts a leaf', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // Bindings mutate layout trees in place; a resolver cache must not retain an earlier tree’s answer.
  it('resolves a leaf grafted in place by a split spawn', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt1: [makeTerminalTab({ id: 'tab1', worktreeId: 'wt1', ptyId: 'pty-source' })]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-source' }
        }
      }
    })
    // Warm the resolver as the window-graph lease sweep does before a split spawn.
    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)).toBe('tab1')

    expect(
      await store.persistPtyBinding({
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_2,
        ptyId: 'pty-split'
      })
    ).toBe(true)

    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_2)).toBe('tab1')
    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)).toBe('tab1')
  })

  it('resolves the first leaf grafted onto an empty layout', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt1: [makeTerminalTab({ id: 'tab1', worktreeId: 'wt1', ptyId: null })]
      },
      terminalLayoutsByTabId: {
        tab1: { root: null, activeLeafId: null, expandedLeafId: null, ptyIdsByLeafId: {} }
      }
    })
    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)).toBeUndefined()

    expect(
      await store.persistPtyBinding({
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_1,
        ptyId: 'pty-first'
      })
    ).toBe(true)

    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)).toBe('tab1')
  })
})
