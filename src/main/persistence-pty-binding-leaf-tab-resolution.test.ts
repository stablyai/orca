import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { findTerminalTabIdForLeaf } from './runtime/workspace-session-terminal-membership-authority'
import { testState, createStore, makeTerminalTab } from './persistence-test-harness'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

describe('findTerminalTabIdForLeaf after persistPtyBinding grafts a leaf', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // `persistPtyBinding` grafts the leaf by assigning `layout.root` on the SAME layout object inside
  // the SAME layouts record (pty-binding-persistence.ts), so the resolver has to answer from the
  // tree that is there now, not from anything derived on an earlier call.
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
    // A reader runs first, exactly as the syncWindowGraph lease sweep does.
    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)).toBe('tab1')

    expect(
      store.persistPtyBinding({
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_2,
        ptyId: 'pty-split'
      })
    ).toBe(true)

    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_2)).toBe('tab1')
    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)).toBe('tab1')
  })

  // The other in-place graft: an empty persisted layout gets its first durable root.
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
      store.persistPtyBinding({
        worktreeId: 'wt1',
        tabId: 'tab1',
        leafId: TEST_LEAF_1,
        ptyId: 'pty-first'
      })
    ).toBe(true)

    expect(findTerminalTabIdForLeaf(store.getWorkspaceSession(), TEST_LEAF_1)).toBe('tab1')
  })
})
