import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, testState } from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

describe('operator-closed SSH lease tombstones', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  /** A pane whose lease froze `tab-old` before `detachTerminalPaneToTab` moved it to `tab-new`.
   *  The binding scrub matches tab-qualified, so it cannot reach this row's binding. */
  async function storeWithDetachedPaneBinding(): Promise<Awaited<ReturnType<typeof createStore>>> {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId: 'wt1',
      tabId: 'tab-old',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab-new',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-new',
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
        'tab-new': {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty' }
        }
      }
    })
    return store
  }

  it('keeps the tombstone while a binding the scrub could not reach still names the pty', async () => {
    const store = await storeWithDetachedPaneBinding()

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty', 'terminated')

    // `isRestorablePtyBinding` still consults this row to refuse replaying that binding.
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({ ptyId: 'remote-pty', state: 'terminated' })
    ])
    expect(store.getWorkspaceSession().terminalLayoutsByTabId['tab-new'].ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'ssh:ssh-1@@remote-pty'
    })
  })

  it('keeps an operator-closed lease that still owes an undelivered stop', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'remote-pty', state: 'attached' })
    store.recordSshRemotePtyKillIntent('ssh-1', 'remote-pty', {
      incarnationId: 'inc-1',
      requestedAt: 1,
      attempts: 0
    })

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty', 'terminated')

    expect(store.getSshRemotePtyKillIntents('ssh-1', 2)).toHaveLength(1)
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({ ptyId: 'remote-pty', state: 'terminated' })
    ])
  })

  // `expired` is never evidence the shell died, and `sweepOrphanedRelayPtys` reads these ids as its
  // leave-alone list, so dropping one would authorize stopping a process left running on purpose.
  it('keeps a superseded expired lease when a sibling pane is closed', async () => {
    const store = await createStore()
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-1',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty-2',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId: 'remote-pty-3', state: 'attached' })

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty-3', 'terminated')

    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({
        ptyId: 'remote-pty-1',
        state: 'expired',
        supersededBy: 'remote-pty-2'
      }),
      expect.objectContaining({ ptyId: 'remote-pty-2', state: 'attached' })
    ])
  })

  it('retires every unreachable tombstone for the target, not only the one just closed', async () => {
    const store = await createStore()
    for (const ptyId of ['remote-pty-1', 'remote-pty-2', 'remote-pty-3']) {
      store.upsertSshRemotePtyLease({ targetId: 'ssh-1', ptyId, state: 'terminated' })
    }
    store.upsertSshRemotePtyLease({ targetId: 'ssh-2', ptyId: 'other-pty', state: 'terminated' })
    expect(store.getSshRemotePtyLeases()).toHaveLength(4)

    store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty-1', 'terminated')

    // Other targets are untouched: the pass is scoped to the one whose bindings were just scrubbed.
    expect(store.getSshRemotePtyLeases()).toEqual([
      expect.objectContaining({ targetId: 'ssh-2', ptyId: 'other-pty' })
    ])
  })
})
