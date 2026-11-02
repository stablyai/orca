import { expect, it, vi } from 'vitest'
import { identityFixture, LEAF, PANE } from '../query/terminal-identity.test-fixture'
import {
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  TEST_WORKTREE_ID
} from '../../orca-runtime-test-fixtures.spec'
import { recordPtySurface, forgetPtySurface } from '../../pty-recorded-surface-topology'
import type { TerminalLeafMoveResult } from '../../../../shared/terminal-leaf-move'

it('retires before dependent callbacks, keeps connected output idle and preserves partial writes when a callback fails', () => {
  const f = identityFixture()
  const pty = f.owner.recordPtyWorktree('pty-owned', TEST_WORKTREE_ID)
  const changes: (string | null | undefined)[] = []
  const stop = f.owner.crewChanges.subscribe(() => changes.push(pty.paneKey))
  recordPtySurface(f.owner.source, pty, 'tab-original', PANE, 3)
  expect(changes).toEqual([PANE])
  recordPtySurface(f.owner.source, pty, 'tab-original', PANE, 2)
  expect(changes).toEqual([PANE])
  f.owner.source.replaceLeaves(f.owner.leaves)
  f.owner.source.bindPty('pty-owned', 'term_owned')
  const before = changes.length
  f.owner.source.bindPty('pty-owned', 'term_owned')
  for (let i = 0; i < 30; i++) {
    f.runtime.onPtyData('pty-owned', 'output', 500 + i)
  }
  expect(changes).toHaveLength(before)
  const fail = f.owner.crewChanges.subscribe(() => {
    throw new Error('consumer_failure')
  })
  expect(() => forgetPtySurface(f.owner.source, pty)).not.toThrow()
  expect(pty.paneKey).toBeNull()
  expect(changes.at(-1)).toBeNull()
  fail()
  expect(() => {
    recordPtySurface(f.owner.source, pty, 'tab-original', PANE, 4)
    throw new Error('later_operation_failure')
  }).toThrow('later_operation_failure')
  expect(changes.at(-1)).toBe(PANE)
  stop()
})

it('wakes for preallocation before any leaf or incarnation and for a real pane move only after its awaited commit', async () => {
  const harness = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
  const f = identityFixture(undefined, harness.runtimeStore)
  const wake = vi.fn()
  const stop = f.owner.crewChanges.subscribe(wake)
  const old = f.runtime.createTerminalIdentityReadContext()
  expect(f.owner.getLivePtyForHandle('absent', old)).toBeNull()
  const handle = f.runtime.preAllocateHandleForPty('pty-owned')
  expect(wake).toHaveBeenCalledTimes(1)
  expect(f.owner.handleByPtyId.get('pty-owned')).toBe(handle)
  expect(f.owner.leaves.size).toBe(0)
  expect(f.owner.handleByPtyIncarnation.size).toBe(0)
  f.runtime.onPtySpawned('pty-owned')
  const pty = f.owner.recordPtyWorktree('pty-owned', TEST_WORKTREE_ID, { paneKey: PANE })
  let finish: ((result: TerminalLeafMoveResult) => void) | undefined
  const commit = vi.fn(
    () =>
      new Promise<TerminalLeafMoveResult>((resolve) => {
        finish = resolve
      })
  )
  const move = f.runtime.moveMobileSessionLeafToNewTab(
    `id:${TEST_WORKTREE_ID}`,
    {
      sourceTabId: 'tab-original',
      targetTabId: 'tab-moved',
      leafId: LEAF
    },
    commit
  )
  expect(commit).toHaveBeenCalledOnce()
  const before = wake.mock.calls.length
  expect(pty.paneKey).toBe(PANE)
  const warmed = f.runtime.createTerminalIdentityReadContext()
  f.owner.getPtyRecordForPaneKey(`tab-moved:${LEAF}`, warmed)
  if (!finish) {
    throw new Error('Expected the production move to await commit')
  }
  finish({ status: 'moved', ptyId: 'pty-owned' })
  await expect(move).resolves.toEqual({ status: 'moved', ptyId: 'pty-owned' })
  expect(pty.paneKey).toBe(`tab-moved:${LEAF}`)
  expect(wake.mock.calls.length).toBeGreaterThan(before)
  expect(
    f.owner.getPtyRecordForPaneKey(
      `tab-moved:${LEAF}`,
      f.runtime.createTerminalIdentityReadContext()
    )
  ).toBe(f.owner.getPtyRecordForPaneKey(`tab-moved:${LEAF}`))
  stop()
})
