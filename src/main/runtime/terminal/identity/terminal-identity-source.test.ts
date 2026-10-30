import { expect, it, vi } from 'vitest'
import {
  identityFixture,
  identityGraph as graph,
  LEAF,
  PANE
} from '../query/terminal-identity.test-fixture'
import {
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  TEST_WORKTREE_ID
} from '../../orca-runtime-test-fixtures.spec'
import { recordPtySurface, forgetPtySurface } from '../../pty-recorded-surface-topology'
import type { TerminalLeafMoveResult } from '../../../../shared/terminal-leaf-move'
import { meterIncarnationCandidates } from './terminal-incarnation-candidates.test-fixture'

it('owns consumed creation aliases while preserving canonical output and retained graph leaf references', () => {
  const f = identityFixture()
  const original = f.owner.recordPtyWorktree('pty-owned', TEST_WORKTREE_ID)
  const input = { ...original }
  const canonical = f.owner.source.createPty(input)
  input.connected = false
  input.paneKey = 'borrowed-alias'
  input.incarnationId = 'borrowed-process'
  expect(canonical.connected).toBe(true)
  expect(canonical.paneKey).not.toBe('borrowed-alias')
  expect(canonical.incarnationId).toBeNull()
  expect(canonical.tailBuffer).toBe(input.tailBuffer)

  f.runtime.attachWindow(1)
  const publication = graph('pty-owned')
  f.runtime.syncWindowGraph(1, publication)
  const leaf = f.owner.leaves.get(`tab-original::${LEAF}`)!
  expect(f.owner.getLeavesForPty('pty-owned')[0]).toBe(leaf)
  publication.leaves[0]!.ptyId = 'external-replacement'
  publication.tabs[0]!.worktreeId = 'external-workspace'
  expect(leaf.ptyId).toBe('pty-owned')
  expect(f.runtime.getTerminalWorktreeIdForHandle(f.owner.issueHandle(leaf))).toBe(TEST_WORKTREE_ID)
  f.owner.source.replaceLeaves(f.owner.leaves)
  expect(f.owner.getLeavesForPty('pty-owned')[0]).toBe(leaf)
  f.runtime.onPtyData('pty-owned', 'canonical output\r\n', 500)
  expect(f.owner.ptysById.get('pty-owned')).toBe(canonical)
  expect(f.owner.getLeavesForPty('pty-owned')[0]).toBe(leaf)
  expect(leaf.preview).toContain('canonical output')

  const handleInput = { ...f.owner.handles.get(f.owner.issueHandle(leaf))! }
  f.owner.source.setHandle(handleInput.handle, handleInput)
  handleInput.ptyId = 'external-handle-write'
  expect(f.owner.handles.get(handleInput.handle)?.ptyId).toBe('pty-owned')
  const incarnationInput = {
    handle: handleInput.handle,
    incarnationId: 'process',
    leafKey: 'original'
  }
  f.owner.source.setIncarnation('pty-owned', incarnationInput)
  incarnationInput.leafKey = 'external-incarnation-write'
  expect(f.owner.handleByPtyIncarnation.get('pty-owned')?.leafKey).toBe('original')
})

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

it('keeps retained candidate order and live validation coherent before reentrant retirement across shared open contexts', () => {
  const indexed = meterIncarnationCandidates()
  indexed.beginRead()
  const f = identityFixture()
  const raw = f.runtime.createTerminalIdentityRawInputs()
  const contexts = [
    undefined,
    f.runtime.createTerminalIdentityReadContext(raw),
    f.runtime.createTerminalIdentityReadContext(raw)
  ]
  const handle = 'term_retained_order'
  const validation = indexed.validation
  indexed.validationMaps(f.owner.handleByPtyIncarnation, f.owner.ptysById)
  const read = () =>
    indexed.validate(() =>
      contexts.map((context) => f.runtime.getTerminalProcessIncarnation(handle, context))
    )
  const oracle = () => {
    const [id, binding] =
      [...f.owner.handleByPtyIncarnation].find(([, row]) => row.handle === handle) ?? []
    const pty = id ? f.owner.ptysById.get(id) : undefined
    return binding?.incarnationId && pty?.incarnationId === binding.incarnationId
      ? `${pty.ptyId}:${pty.incarnationId}`
      : null
  }
  const reentries: { actual: (string | null)[]; expected: string | null }[] = []
  const stop = f.owner.crewChanges.subscribe(() => {
    reentries.push({ actual: read(), expected: oracle() })
  })
  const check = (expected: string | null) => {
    expect(oracle()).toBe(expected)
    expect(read()).toEqual(contexts.map(() => expected))
    for (const entry of reentries) {
      expect(entry.actual).toEqual(contexts.map(() => entry.expected))
    }
  }
  try {
    check(null)
    const first = f.owner.recordPtyWorktree('first', TEST_WORKTREE_ID, { incarnationId: 'one' })
    f.owner.recordPtyWorktree('second', TEST_WORKTREE_ID, { incarnationId: 'two' })
    f.owner.source.setIncarnation('first', {
      handle: 'term_other',
      incarnationId: 'one',
      leafKey: 'a'
    })
    f.owner.source.setIncarnation('second', { handle, incarnationId: 'two', leafKey: 'b' })
    check('second:two')
    const detached = f.owner.handleByPtyIncarnation.get('first')!
    f.owner.source.setIncarnation('first', { handle, incarnationId: 'one', leafKey: 'a' })
    check('first:one')
    f.owner.source.setIncarnationLeaf(detached, 'detached-leaf')
    f.owner.source.setIncarnationProcess(detached, 'detached-process')
    expect(f.owner.handleByPtyIncarnation.get('first')).toEqual({
      handle,
      incarnationId: 'one',
      leafKey: 'a'
    })
    check('first:one')
    const current = f.owner.handleByPtyIncarnation.get('first')!
    f.owner.source.setIncarnationLeaf(current, 'moved-leaf')
    check('first:one')
    const quiet = reentries.length
    f.owner.source.setIncarnation('first', { ...current })
    f.owner.source.setIncarnationLeaf(current, 'moved-leaf')
    f.owner.source.setIncarnationProcess(current, 'one')
    expect(reentries).toHaveLength(quiet)
    f.owner.source.setPtyConnected(first, false)
    check('first:one')
    f.owner.source.setIncarnationProcess(f.owner.handleByPtyIncarnation.get('first')!, null)
    check(null)
    f.owner.source.setIncarnationProcess(f.owner.handleByPtyIncarnation.get('first')!, 'one')
    f.owner.source.setPtyIncarnationId(first, 'replacement')
    check(null)
    f.owner.source.setPtyIncarnationId(first, 'one')
    check('first:one')
    const throwing = f.owner.crewChanges.subscribe(() => {
      throw new Error('notification_failure')
    })
    expect(() => f.owner.source.removeIncarnation('first')).not.toThrow()
    check('second:two')
    throwing()
    f.owner.source.setIncarnation('first', { handle, incarnationId: 'one', leafKey: 'again' })
    check('second:two')
    expect(() => {
      f.owner.source.removeIncarnation('second')
      throw new Error('later_failure')
    }).toThrow('later_failure')
    check('first:one')
    f.owner.source.removePty('first')
    check(null)
    f.owner.source.clearIncarnations()
    check(null)
    const cleared = reentries.length
    expect(f.owner.source.removeIncarnation('first')).toBe(false)
    f.owner.source.clearIncarnations()
    expect(reentries).toHaveLength(cleared)
    expect(reentries.length).toBeGreaterThan(0)
    expect(indexed.lookup.candidates).toBeGreaterThan(0)
    expect(indexed.lookup.get).toBe(indexed.lookup.calls)
    expect(indexed.maintenance.shifted).toBeGreaterThan(0)
    expect(validation.bindings).toBe(indexed.lookup.candidates)
    expect(validation.ptys).toBeGreaterThanOrEqual(validation.bindings)
    console.info('retained canonical ordered work', {
      maintenance: indexed.maintenance,
      lookup: indexed.lookup,
      validation
    })
  } finally {
    indexed.close()
    stop()
  }
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
