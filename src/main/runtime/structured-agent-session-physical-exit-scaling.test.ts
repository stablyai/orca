import { afterEach, expect, it, vi } from 'vitest'
import { claudePipedFixture, SESSION } from './structured-claude-piped-test-support'
import { nativeSwitchPhysicalFixture } from './structured-native-switch-physical.test-fixture'
import { SUPERVISED_GRACEFUL_EXIT_MS } from '../claude/claude-child-exit-proof-ladder'
import { attachParamsForRecord } from '../native-chat/agent-session-wire/structured-agent-session-conversation-open'
import { hostTestAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import * as settlements from '../../shared/promise-settlement-waiters'

vi.mock('../pty-descendant-termination', () => ({
  captureDescendantSnapshot: async (pid: number) => ({
    rootPgid: pid,
    capturedAtMs: 1,
    root: { pid, startedAt: 'Mon Jan 1 00:00:00 2026' },
    descendants: [{ pid: pid + 1, ppid: pid, pgid: pid + 1, startedAt: 'Mon Jan 1 00:00:00 2026' }]
  })
}))
vi.mock('../pty-descendant-exit-verification', () => ({
  terminateDescendantSnapshotWithVerdict: async () => 'unverifiable'
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([10, 100])(
  'bounds actual physical-owner joins and expired switch retries at %i acquisitions',
  async (count) => {
    const fixture = await claudePipedFixture()
    const flights = fixture.host.collaboratorsForTests().runtimeState.startFlights
    const owners = new Map<unknown, { sessionId: string; reactions: () => number }>()
    const observers = new Map<unknown, { readonly waiterCount: number }>()
    const visited: unknown[] = []
    const removed: unknown[] = []
    let currentChecks = 0
    const observe = flights.observePhysicalExit.bind(flights)
    vi.spyOn(flights, 'observePhysicalExit').mockImplementation((id, exited, covered) => {
      const then = vi.spyOn(exited, 'then')
      owners.set(exited, { sessionId: id, reactions: () => then.mock.calls.length })
      return observe(id, exited, covered)
    })
    const shared = settlements.sharedPromiseSettlementWaiters
    vi.spyOn(settlements, 'sharedPromiseSettlementWaiters').mockImplementation(
      <T>(promise: Promise<T>) => {
        const observer = shared(promise)
        if (owners.has(promise)) {
          observers.set(promise, observer)
        }
        return observer
      }
    )
    const values = Set.prototype.values
    function observedValues(this: Set<unknown>) {
      const iterator = values.call(this)
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const result = next(...args)
        if (!result.done && owners.has(result.value)) {
          visited.push(result.value)
        }
        return result
      }
      return iterator
    }
    vi.spyOn(Set.prototype, 'values').mockImplementation(observedValues)
    vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(observedValues)
    const deleteEntry = Set.prototype.delete
    vi.spyOn(Set.prototype, 'delete').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      const deleted = deleteEntry.call(this, value)
      if (deleted && owners.has(value)) {
        removed.push(value)
      }
      return deleted
    })
    const physicalExit = flights.physicalExit.bind(flights)
    vi.spyOn(flights, 'physicalExit').mockImplementation((...args) => {
      const view = physicalExit(...args)
      return {
        ...view,
        current: () => {
          currentChecks++
          return view.current()
        }
      }
    })
    const waiterCount = () => [...observers.values()].reduce((n, o) => n + o.waiterCount, 0)
    const reactions = () => [...owners.values()].reduce((n, o) => n + o.reactions(), 0)
    const forceClose = () => vi.advanceTimersByTimeAsync(SUPERVISED_GRACEFUL_EXIT_MS + 8000)
    const paramsFor = (id: string) => {
      const generated = fixture.params()
      const record = fixture.host.deps.store.getRecord(id)
      return record
        ? attachParamsForRecord(record, {
            clientOperationId: generated.envelope.clientOperationId,
            expectedRuntimeFence: record.lease.runtimeFence
          })
        : hostTestAttachParams(null, {
            ...generated,
            envelope: { ...generated.envelope, sessionId: id }
          })
    }
    const retire = async (id: string) => {
      expect(await fixture.host.attach(fixture.caller, paramsFor(id))).toMatchObject({ ok: true })
      await vi.waitFor(() =>
        expect(fixture.host.readStatusSummary(id)?.hostExecutionPhase).toBe('ready')
      )
      const index = fixture.children.length - 1
      fixture.permitKill.add(index)
      const closing = fixture.host.close(id, 'evict')
      await forceClose()
      await closing
      expect(fixture.connections[index]!.exitVerdict).toMatchObject({
        root: 'live',
        killDelivered: true
      })
      return index
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const identity = Promise.withResolvers<void>()
    let switching: Awaited<ReturnType<typeof nativeSwitchPhysicalFixture>> | undefined
    try {
      const target: number[] = []
      for (let n = 0; n < count; n++) {
        target.push(await retire(SESSION))
      }
      for (let n = 0; n < count; n++) {
        await retire('unrelated-session')
      }
      expect(owners.size).toBe(2 * count)
      switching = await nativeSwitchPhysicalFixture(
        fixture.host,
        SESSION,
        fixture.directory,
        'claude'
      )
      for (let n = 0; n < count; n++) {
        const expired = switching.run(1000).catch((error: unknown) => error)
        await vi.waitFor(() => expect(waiterCount()).toBe(1))
        await vi.advanceTimersByTimeAsync(1001)
        expect(await expired).toMatchObject({
          refusal: { code: 'agent_session_operation_expired' }
        })
        expect(waiterCount()).toBe(0)
      }
      expect(visited).toHaveLength(count)
      expect(reactions()).toBe(2 * count + 1)
      expect(switching.spawn).not.toHaveBeenCalled()
      const surviving = switching.run().catch((error: unknown) => error)
      await vi.waitFor(() => expect(waiterCount()).toBe(1))
      const beforeCurrent = { visits: visited.length, reactions: reactions() }
      const view = flights.physicalExit(SESSION, true)
      for (let n = 0; n < count; n++) {
        expect(view.current()).toBe(false)
      }
      expect({ visits: visited.length, reactions: reactions() }).toEqual(beforeCurrent)

      const later = fixture.children.length
      fixture.heldIdentity.set(9100000 + later * 100, identity.promise)
      fixture.permitKill.add(later)
      const ensuring = fixture.host
        .attach(fixture.caller, paramsFor(SESSION))
        .catch((error: unknown) => error)
      await vi.waitFor(() => expect(fixture.connections).toHaveLength(later + 1))
      fixture.children[later]!.stdin.emit('error', new Error('ordinary later ensure failed'))
      await forceClose()
      identity.resolve()
      await forceClose()
      expect(await ensuring).toMatchObject({ ok: false })
      expect(owners.size).toBe(2 * count + 1)
      const kills = fixture.signal.mock.calls.length
      const afterRetries = visited.length - 1
      for (const index of target) {
        fixture.observedExit(index)
        await vi.advanceTimersByTimeAsync(0)
        await fixture.drain()
      }
      await vi.waitFor(() => expect(visited).toHaveLength(2 * count + 1))
      expect(removed).toHaveLength(count)
      expect(switching.spawn).not.toHaveBeenCalled()
      expect(waiterCount()).toBe(1)
      const completed = new Set(removed)
      expect(visited.slice(afterRetries)).toHaveLength(count + 1)
      expect(new Set(visited.slice(afterRetries)).size).toBe(count + 1)
      fixture.observedExit(later)
      await vi.advanceTimersByTimeAsync(0)
      expect(await surviving).toMatchObject({ status: 'completed' })
      expect(switching.spawn).toHaveBeenCalledOnce()
      expect(fixture.signal.mock.calls).toHaveLength(kills)
      expect(waiterCount()).toBe(0)
      expect(removed).toHaveLength(count + 1)
      expect(reactions()).toBe(3 * count + 2)
      expect(currentChecks).toBeGreaterThanOrEqual(2 * count + 1)
      expect(currentChecks).toBeLessThan(3 * count + 20)
      expect([...observers.keys()].every((p) => owners.get(p)?.sessionId === SESSION)).toBe(true)
      expect(removed.slice(count).some((p) => completed.has(p))).toBe(false)
      expect(view.current()).toBe(true)
      expect(fixture.prompts).toEqual([])
      console.info(
        'native-physical-counts',
        JSON.stringify({
          acquisitions: owners.size,
          retries: count,
          traversed: visited.length,
          reactions: reactions(),
          currentChecks,
          liveWaiters: waiterCount(),
          removed: removed.length,
          destinations: switching.spawn.mock.calls.length
        })
      )
    } finally {
      identity.resolve()
      switching?.dispose()
      await fixture.dispose()
    }
  }
)
