import { identityFixture as fixture, PANE } from './terminal-identity.test-fixture'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'
import { CrewReadModel } from '../../orchestration/crew/crew-read-model'
import { readCrewRuntimeInputs } from '../../orchestration/crew/crew-runtime-watch'
import { expect, it, vi } from 'vitest'
import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { TEST_WORKTREE_ID } from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import '../../rpc/methods/orchestration/runs/runs'
import '../../rpc/methods/orchestration/runs/run-scope'
import '../../../../shared/orca-session-address'
import '../../../../shared/orca-session-address-test-fixture'

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
