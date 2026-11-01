import { identityFixture as fixture, LEAF, PANE } from './terminal-identity.test-fixture'
import { OrchestrationDb } from '../../orchestration/db'
import { CrewReadModel } from '../../orchestration/crew/crew-read-model'
import { readCrewRuntimeInputs } from '../../orchestration/crew/crew-runtime-watch'
import { expect, it, vi } from 'vitest'
import '../../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID } from '../../orca-runtime-test-fixtures.spec'
import { createBoundRun } from '../../rpc/methods/orchestration/runs/runs'
import { resolveOrchestrationCaller } from '../../rpc/methods/orchestration/runs/run-scope'
import { formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'

function countIterations<K, V>(
  map: ReadonlyMap<K, V>,
  counts: { entries: number; get: number; set: number; delete: number }
) {
  if (!(map instanceof Map)) {
    throw new Error('Expected native map instrumentation')
  }
  const get = map.get.bind(map)
  const set = map.set.bind(map)
  const remove = map.delete.bind(map)
  map.get = (key: K) => {
    counts.get++
    return get(key)
  }
  map.set = (key: K, value: V) => {
    counts.set++
    return set(key, value)
  }
  map.delete = (key: K) => {
    counts.delete++
    return remove(key)
  }
  for (const method of ['entries', 'keys', 'values', Symbol.iterator] as const) {
    const original = map[method].bind(map)
    Object.defineProperty(map, method, {
      configurable: true,
      value: function* () {
        for (const value of original()) {
          counts.entries++
          yield value
        }
      }
    })
  }
}

it('charges actual native map visits at N/10N for missing, moved and cold identities and leaves fast hits lazy', () => {
  const measure = (population: number, indexed: boolean, fast: boolean) => {
    const f = fixture()
    for (let i = 0; i < population; i++) {
      const pane = `tab-${i}:aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
      f.add(`pty-${i}`, `term_${i}`, pane)
      f.stamp(`term_${i}`, `pty-${i}`)
    }
    const counts = { entries: 0, get: 0, set: 0, delete: 0 }
    countIterations(f.owner.handles, counts)
    countIterations(f.owner.handleByPtyId, counts)
    countIterations(f.owner.leaves, counts)
    countIterations(f.owner.ptysById, counts)
    const context = indexed ? f.runtime.createTerminalIdentityReadContext() : undefined
    for (let i = 0; i < population; i++) {
      f.owner.getLivePtyForHandle(fast ? `term_${i}` : `term_missing_${i}`, context)
      if (!fast) {
        expect(f.owner.getPtyRecordForPaneKey(`missing-${i}:${LEAF}`, context)).toBeNull()
      }
    }
    return counts
  }
  const baseline = [measure(3, false, false), measure(30, false, false)]
  const candidate = [measure(3, true, false), measure(30, true, false)]
  expect(baseline[1].entries).toBe(baseline[0].entries * 100)
  expect(candidate[1].entries).toBe(candidate[0].entries * 10)
  expect(measure(30, true, true).entries).toBe(0)
  const cold = (population: number, indexed: boolean) => {
    const f = fixture()
    for (let i = 0; i < population; i++) {
      f.add(`cold-${i}`, `term_cold_${i}`, `cold-pane-${i}`)
      f.stamp(`term_cold_${i}`, `cold-${i}`)
      f.owner.source.unbindPty(`cold-${i}`)
    }
    const counts = { entries: 0, get: 0, set: 0, delete: 0 }
    countIterations(f.owner.handles, counts)
    countIterations(f.owner.ptysById, counts)
    countIterations(f.owner.handleByPtyId, counts)
    const context = indexed ? f.runtime.createTerminalIdentityReadContext() : undefined
    for (let i = 0; i < population; i++) {
      expect(f.runtime.getTerminalHandleForPaneKey(`cold-pane-${i}`, context)).toBe(
        `term_cold_${i}`
      )
      expect(f.owner.getLivePtyForHandle(`term_cold_${i}`, context)?.pty.ptyId).toBe(`cold-${i}`)
    }
    return counts
  }
  const coldBaseline = [cold(3, false), cold(30, false)]
  const coldCandidate = [cold(3, true), cold(30, true)]
  expect(coldBaseline[1].entries).toBeGreaterThan(coldBaseline[0].entries * 50)
  expect(coldCandidate[1].entries).toBe(coldCandidate[0].entries * 10)
})

it('invalidates actual SSH-held facts on register and finally-release with equal and conflicting claims', async () => {
  const f = fixture()
  const wake = vi.fn()
  const stop = f.owner.crewChanges.subscribe(wake)
  const terminal = { handle: 'term_ssh', paneKey: PANE, processIncarnation: 'remote-process' }
  const first = f.runtime.registerOrchestrationCompatibilitySshAttachment('target', 'one', terminal)
  const equal = f.runtime.registerOrchestrationCompatibilitySshAttachment('target', 'two', terminal)
  expect(wake).toHaveBeenCalledTimes(2)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  const ctx = f.runtime.createTerminalIdentityReadContext()
  expect(f.owner.getOrchestrationCompatibilitySshTerminal(terminal.handle, ctx)).toEqual(terminal)
  expect(f.runtime.getTerminalProcessIncarnation(terminal.handle, ctx)).toBe('remote-process')
  const conflict = f.runtime.registerOrchestrationCompatibilitySshAttachment(
    'other-target',
    'three',
    terminal
  )
  try {
    // A changed source owns a fresh finite context; the old context is never retained as authority.
    expect(
      f.owner.getOrchestrationCompatibilitySshTerminal(
        terminal.handle,
        f.runtime.createTerminalIdentityReadContext()
      )
    ).toBeUndefined()
    expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBeNull()
    await Promise.resolve()
  } finally {
    f.runtime.releaseOrchestrationCompatibilitySshAttachment(conflict.attachmentId)
  }
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(first.attachmentId)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(equal.attachmentId)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBeNull()
  expect(wake).toHaveBeenCalledTimes(6)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(equal.attachmentId)
  expect(wake).toHaveBeenCalledTimes(6)
  stop()
})

it('reuses raw inputs for new historical parties through the production Crew boundary and retires them on real owner writes', () => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-28T20:00:00.000Z')
  const measure = (population: number, captured: boolean) => {
    const f = fixture()
    const db = new OrchestrationDb(':memory:')
    f.runtime.setOrchestrationDb(db)
    f.add('coordinator', 'term_coord')
    f.stamp('term_coord', 'coordinator')
    for (let i = 0; i < population; i++) {
      f.add(`unrelated-${i}`, `term_inventory_${i}`, `inventory-${i}`)
    }
    const counts = { entries: 0, get: 0, set: 0, delete: 0 }
    countIterations(f.owner.handles, counts)
    countIterations(f.owner.ptysById, counts)
    countIterations(f.owner.handleByPtyId, counts)
    const capture = vi.spyOn(f.runtime, 'createTerminalIdentityRawInputs')
    const model = new CrewReadModel(
      (previous) => {
        const inputs = readCrewRuntimeInputs(f.owner.crewReaders, db, true, 'same-host', previous)
        if (captured) {
          return inputs
        }
        delete inputs.openIdentityRead
        delete inputs.openRuntimeIdentityRead
        return inputs
      },
      (wake) => {
        const stops = [f.owner.crewChanges.subscribe(wake), db.crewChanges.subscribe(wake)]
        return () => stops.forEach((stop) => stop())
      }
    )
    const wake = vi.fn()
    const stop = model.subscribe(wake)
    try {
      expect(model.read('term_coord').sections.talkingWith).toEqual([])
      for (let i = 0; i < population; i++) {
        db.insertMessage({
          from: `term_late_${i}`,
          to: 'term_coord',
          subject: 'Hello',
          body: `message-${i}`
        })
      }
      db.db.prepare("UPDATE messages SET created_at = '2026-10-28 20:00:00'").run()
      const output = model.read('term_coord')
      expect(output.sections.talkingWith).toHaveLength(population)
      const acquisition = { ...counts }
      if (captured) {
        const captures = capture.mock.calls.length
        f.owner.crewChanges.notify(new Set(['status', 'names']))
        expect(model.read('term_coord')).toEqual(output)
        expect(capture).toHaveBeenCalledTimes(captures)
        expect(counts.entries).toBe(acquisition.entries)
        // Register's actual controller handle, without another DB/status mutation, retires captured absence.
        f.runtime.registerPty('late-pty', TEST_WORKTREE_ID, null, {
          tabId: 'tab-late',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          terminalHandle: 'term_late_0'
        })
        const installed = model
          .read('term_coord')
          .sections.talkingWith.find((row) => row.sendAddress === 'term_late_0')
        expect(installed?.openTarget).toEqual({ kind: 'terminal', handle: 'term_late_0' })
        expect(capture.mock.calls.length).toBeGreaterThan(captures)
        // Owner repair may dirty the generation once; the next read must settle, never feed a rebuild loop.
        model.read('term_coord')
        expect(capture.mock.calls.length).toBeLessThanOrEqual(captures + 2)
        const afterInstallation = capture.mock.calls.length
        f.owner.recordPtyWorktree('late-pty', TEST_WORKTREE_ID, {
          lastOutputAt: 500,
          preview: 'unconsumed output'
        })
        model.read('term_coord')
        expect(capture).toHaveBeenCalledTimes(afterInstallation)
        const mutation = (write: () => unknown) => {
          const before = capture.mock.calls.length
          write()
          model.read('term_coord')
          expect(capture.mock.calls.length).toBeGreaterThan(before)
          model.read('term_coord')
          const settled = capture.mock.calls.length
          model.read('term_coord')
          expect(capture).toHaveBeenCalledTimes(settled)
        }
        const pty = f.owner.ptysById.get('late-pty')!
        mutation(() => f.owner.setPtyConnected(pty, false))
        const disconnected = capture.mock.calls.length
        f.owner.setPtyConnected(pty, false)
        model.read('term_coord')
        expect(capture).toHaveBeenCalledTimes(disconnected)
        mutation(() => f.runtime.onPtyData('late-pty', 'resume', 500))
        const resumed = capture.mock.calls.length
        const normalEntries = counts.entries
        const normalWakes = wake.mock.calls.length
        for (let i = 0; i < population; i++) {
          f.runtime.onPtyData('late-pty', 'ordinary output', 501 + i)
          model.read('term_coord')
        }
        expect(capture).toHaveBeenCalledTimes(resumed)
        expect(counts.entries).toBe(normalEntries)
        expect(wake).toHaveBeenCalledTimes(normalWakes)
        mutation(() => f.owner.setPtyConnected(pty, false))
        mutation(() => f.runtime.onPtySpawned('late-pty', 'new-process'))
        mutation(() =>
          f.owner.recordPtyWorktree('late-pty', TEST_WORKTREE_ID, {
            paneKey: 'tab-moved:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
          })
        )
        f.runtime.attachWindow(1)
        mutation(() => f.owner.beginGraphReload(1))
        mutation(() => f.owner.dropDisconnectedPtyRecord('late-pty'))
        expect(
          model
            .read('term_coord')
            .sections.talkingWith.find((row) => row.sendAddress === 'term_late_0')?.openTarget
        ).toBeUndefined()
        stop()
        const beforeReenroll = capture.mock.calls.length
        const release = model.subscribe(wake)
        model.read('term_coord')
        expect(capture).toHaveBeenCalledTimes(beforeReenroll + 1)
        release()
      }
      return { output, acquisition }
    } finally {
      stop()
      db.close()
    }
  }
  try {
    for (const population of [3, 30]) {
      const baseline = measure(population, false)
      const candidate = measure(population, true)
      expect(candidate.output).toEqual(baseline.output)
      expect(candidate.acquisition.entries).toBeLessThan(baseline.acquisition.entries)
      expect(candidate.acquisition.entries).toBeLessThan(10 * (population + 1))
    }
  } finally {
    vi.useRealTimers()
  }
})

it('charges retained incarnation materialization through actual pending-pane Run producers and the complete Crew read', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-28T20:00:00Z') })
  const measure = async (peers: number, inventory: number) => {
    const f = fixture()
    const db = new OrchestrationDb(':memory:')
    f.runtime.setOrchestrationDb(db)
    const graph: RuntimeSyncWindowGraph = {
      tabs: [
        {
          tabId: 'tab-cost',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Cost',
          activeLeafId: null,
          layout: null
        }
      ],
      leaves: []
    }
    for (let i = 0; i < peers + inventory; i++) {
      const leafId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
      const ptyId = i < peers ? null : `inventory-${i}`
      graph.leaves.push({
        tabId: 'tab-cost',
        worktreeId: TEST_WORKTREE_ID,
        leafId,
        paneRuntimeId: i + 1,
        ptyId
      })
      if (ptyId) {
        f.runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
          incarnationId: `process-${i}`,
          tabId: 'tab-cost',
          leafId
        })
      }
    }
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, graph)
    for (const leaf of graph.leaves.slice(peers)) {
      expect(f.runtime.getTerminalHandleForPaneKey(`tab-cost:${leaf.leafId}`)).toMatch(/^term_/)
    }
    const self = formatOrcaSessionAddress(testOrcaSessionId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'))
    const pendingHandles: string[] = []
    for (const leaf of graph.leaves.slice(0, peers)) {
      graph.tabs[0].activeLeafId = leaf.leafId
      f.runtime.syncWindowGraph(1, graph)
      const handle = await f.runtime.resolveActiveTerminal()
      const caller = resolveOrchestrationCaller(f.runtime, {
        callerTerminalHandle: handle,
        callerSession: undefined,
        requireStablePane: true
      })
      expect(caller.paneKey).toBe(`tab-cost:${leaf.leafId}`)
      expect(f.owner.handles.get(handle)?.ptyId).toBeNull()
      const run = createBoundRun(f.runtime, caller, handle, 'Pending coordinator')
      db.insertMessage({
        from: `run:${run.id}`,
        to: self,
        subject: 'Retained Run',
        body: `peer-${pendingHandles.length}`
      })
      pendingHandles.push(handle)
    }
    expect(f.owner.handleByPtyIncarnation.size).toBe(inventory)
    const counts = { invocations: 0, yielded: 0 }
    const incarnations = f.owner.handleByPtyIncarnation
    const iterate = incarnations[Symbol.iterator].bind(incarnations)
    Object.defineProperty(incarnations, Symbol.iterator, {
      configurable: true,
      value: function* () {
        counts.invocations++
        for (const entry of iterate()) {
          counts.yielded++
          yield entry
        }
      }
    })
    const process = vi.spyOn(f.runtime, 'getTerminalProcessIncarnation')
    const model = new CrewReadModel(
      (previous) => readCrewRuntimeInputs(f.owner.crewReaders, db, true, 'cost-host', previous),
      f.owner.crewChanges.subscribe
    )
    const stop = model.subscribe(() => {})
    try {
      const output = model.read(self)
      expect(output.status).toBe('ok')
      expect(output.sections.talkingWith).toHaveLength(peers)
      for (const handle of pendingHandles) {
        expect(process.mock.calls.some(([current]) => current === handle)).toBe(true)
      }
      expect(counts.yielded).toBeLessThanOrEqual(4 * inventory + 4 * peers)
    } finally {
      stop()
      process.mockRestore()
      db.close()
    }
  }
  try {
    for (const [peers, inventory] of [
      [3, 3],
      [30, 30]
    ]) {
      await measure(peers, inventory)
    }
  } finally {
    vi.useRealTimers()
  }
})
