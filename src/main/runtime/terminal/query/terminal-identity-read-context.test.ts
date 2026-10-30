import { identityFixture as fixture, LEAF, COLD, PANE } from './terminal-identity.test-fixture'
import { AgentHookServer } from '../../../agent-hooks/server'
import { agentHookRuntimeDeps } from '../../../agent-hooks/agent-hook-runtime-deps'
import {
  AgentStatusObservedPaneIdentities,
  recordObservedAgentStatusPaneIdentity
} from '../../agent-status-observed-pane-identity'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import type { ObservedAgentStatusPaneIdentity } from '../../../ipc/agent-status-ipc-boundary'
import { enrichAgentStatusIpcPayload } from '../../../ipc/agent-status-ipc-boundary'
import { OrchestrationDb } from '../../orchestration/db'
import { CrewReadModel } from '../../orchestration/crew/crew-read-model'
import { readCrewRuntimeInputs } from '../../orchestration/crew/crew-runtime-watch'
import { expect, it, vi } from 'vitest'
import '../../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID } from '../../orca-runtime-test-fixtures.spec'
import type { TerminalIdentityReadContext } from './terminal-identity-read-context'

it('matches separate production runtimes across reverse repair, stale first mapping, adoption and dependent reads in either order', () => {
  for (const reverseOrder of [false, true]) {
    for (const absentFirst of [false, true]) {
      const baseline = fixture()
      const candidate = fixture()
      for (const f of [baseline, candidate]) {
        f.owner.source.bindPty('absent-first', 'term_shared')
        if (!absentFirst) {
          f.add('absent-first', 'term_shared', 'malformed-pane', false)
        }
        f.add('live-second', 'term_shared', 'repaired-second')
        f.add('cold', 'term_cold', COLD)
        f.stamp('term_cold', 'cold')
        f.owner.source.unbindPty('cold')
        f.add('adopted', 'term_adopted', `tab-new:${LEAF}`)
        f.runtime.attachWindow(1)
        f.runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: 'tab-new',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal',
              activeLeafId: LEAF,
              layout: null
            }
          ],
          leaves: [
            {
              tabId: 'tab-new',
              worktreeId: TEST_WORKTREE_ID,
              leafId: LEAF,
              paneRuntimeId: 1,
              ptyId: 'adopted'
            }
          ]
        })
        // The production reload writer clears handle records while retaining CLI reverse mappings.
        f.owner.beginGraphReload(1)
        expect(f.owner.handles.has('term_adopted')).toBe(false)
        f.stamp('term_cold', 'cold')
      }
      const context = candidate.runtime.createTerminalIdentityReadContext()
      const read = (f: ReturnType<typeof fixture>, ctx?: TerminalIdentityReadContext) => {
        const actions = [
          () => f.owner.getLivePtyForHandle('term_absent', ctx)?.pty.ptyId ?? null,
          () => f.owner.getLivePtyForHandle('term_shared', ctx)?.pty.ptyId ?? null,
          () => f.runtime.getTerminalHandleForPaneKey('repaired-second', ctx),
          () => f.owner.getLivePtyForHandle('term_shared', ctx)?.pty.ptyId ?? null,
          () => f.owner.getPtyRecordForPaneKey(PANE, ctx)?.ptyId ?? null,
          () => f.runtime.getTerminalHandleForPaneKey(`tab-new:${LEAF}`, ctx),
          () => f.owner.getLivePtyForHandle('term_adopted', ctx)?.pty.ptyId ?? null,
          () => f.runtime.getTerminalHandleForPaneKey('malformed-pane', ctx)
        ]
        if (reverseOrder) {
          actions.reverse()
        }
        const result = actions.map((action) => action())
        // Cold synthetic-record acquisition, then a lookup dependent on the owner's reverse-map write.
        result.push(f.runtime.getTerminalHandleForPaneKey(COLD, ctx))
        result.push(f.owner.getLivePtyForHandle('term_cold', ctx)?.pty.ptyId ?? null)
        return result
      }
      expect(read(candidate, context)).toEqual(read(baseline))
      expect(candidate.state()).toEqual(baseline.state())
    }
  }
})

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
  console.log('cold synthetic native operations', {
    baseline: coldBaseline,
    candidate: coldCandidate
  })
  console.log('terminal acquisition native operations', {
    baseline,
    candidate,
    fast: measure(30, true, true)
  })
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

it('keeps cold candidates coherent through real retained-handle invalidation and waiter rejection', () => {
  const run = (indexed: boolean) => {
    const f = fixture()
    f.add('retained-pty', 'term_retained', PANE)
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-original',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: LEAF,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-original',
          worktreeId: TEST_WORKTREE_ID,
          leafId: LEAF,
          paneRuntimeId: 1,
          ptyId: 'retained-pty'
        }
      ]
    })
    const leaf = f.owner.leaves.get(`tab-original::${LEAF}`)!
    f.owner.source.clearLeafBindings()
    f.owner.source.clearPtyBindings()
    f.stamp('term_retained', 'retained-pty')
    f.owner.source.addSynthetic('term_retained')
    f.owner.source.setIncarnation('retained-pty', {
      handle: 'term_retained',
      incarnationId: 'old-process',
      leafKey: `tab-original::${LEAF}`
    })
    const context = indexed ? f.runtime.createTerminalIdentityReadContext() : undefined
    expect(f.owner.findHandleForPtyRecord('retained-pty', context)).toBe('term_retained')
    const waiterRejected = vi.fn()
    f.owner.terminalWaiters.add({
      handle: 'term_retained',
      condition: 'exit',
      resolve: vi.fn(),
      reject: waiterRejected,
      timeout: null,
      cancelIdlePoll: null,
      abortCleanup: null
    })
    const handle = f.owner.issueHandle(leaf, context)
    expect(waiterRejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'terminal_handle_stale' })
    )
    expect(f.owner.terminalWaiters.get('term_retained')).toBeUndefined()
    expect(handle).not.toBe('term_retained')
    expect(f.owner.findHandleForPtyRecord('retained-pty', context)).toBeNull()
    expect(f.owner.handles.has('term_retained')).toBe(false)
    expect(f.owner.syntheticTerminalHandles.has('term_retained')).toBe(false)
    expect(f.owner.handleByLeafKey.get(`tab-original::${LEAF}`)).toBe(handle)
    expect(f.owner.handles.get(handle)?.ptyId).toBe('retained-pty')
    expect(f.owner.handleByPtyIncarnation.get('retained-pty')?.handle).toBe(handle)
    expect(f.rejected).toHaveBeenCalledWith('term_retained', 'terminal_handle_stale')
    return {
      retainedRemoved: !f.owner.handles.has('term_retained'),
      synthetic: f.owner.syntheticTerminalHandles.size,
      rejected: f.rejected.mock.calls
    }
  }
  expect(run(true)).toEqual(run(false))
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
      console.log('production Crew native acquisition', {
        population,
        baseline: baseline.acquisition,
        candidate: candidate.acquisition
      })
    }
  } finally {
    vi.useRealTimers()
  }
})

it('preserves actual fleet binding, ingestion Dispatch, ordinary attention faults and default IPC effects in separate production runtimes', () => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
  const run = (captured: boolean, fault: boolean) => {
    const raw: AgentStatusIpcPayload[] = []
    const observed = new Map<string, ObservedAgentStatusPaneIdentity>()
    const effectOrder: string[] = []
    let db: OrchestrationDb
    const f = fixture({
      getAgentStatusSnapshot: () => raw,
      readObservedAgentStatusPaneIdentity: (pane) => {
        effectOrder.push(pane)
        if (fault && effectOrder.length === 2) {
          db.db.exec('DROP TABLE attempt_observation_facts')
        }
        return observed.get(pane) ?? { kind: 'unobserved' }
      }
    })
    db = new OrchestrationDb(':memory:')
    f.runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Fleet',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: PANE
    })
    const dispatches: string[] = []
    for (let i = 0; i < 6; i++) {
      const paneKey = `fleet-${i}:aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
      const handle = `term_fleet_${i}`
      f.add(`fleet-pty-${i}`, handle, paneKey)
      f.owner.recordPtyWorktree(`fleet-pty-${i}`, TEST_WORKTREE_ID, {
        incarnationId: `process-${i}`
      })
      const task = db.createTask({ runId: run.id, spec: 'Fleet contract' })
      const dispatch = db.createDispatchContext({
        taskId: task.id,
        assigneeHandle: handle,
        assigneePaneKey: paneKey,
        processIncarnation: `fleet-pty-${i}:process-${i}`,
        creator: { kind: 'system' },
        maxDepth: 10
      })
      dispatches.push(dispatch.id)
      raw.push({
        paneKey,
        agentType: 'codex',
        state: 'working',
        prompt: '',
        connectionId: null,
        receivedAt: 1_800_000_000_000,
        stateStartedAt: 1_800_000_000_000,
        ...(i === 3 ? { restoredUnconfirmed: true, isReplay: true } : {}),
        ...(i === 4 ? { providerSessionOnly: true } : {})
      })
      if (i !== 1) {
        observed.set(paneKey, {
          kind: 'observed',
          terminalHandle: handle,
          processIncarnation: i === 2 ? 'replaced-process' : `fleet-pty-${i}:process-${i}`,
          dispatchId: i === 5 ? null : `ingestion-${i}`
        })
      }
    }
    // Late row still belongs to its ingestion Dispatch, even when the ordinary current projection differs.
    expect(f.runtime.getAgentStatusOrchestrationContextForPaneKey(raw[0].paneKey)?.dispatchId).toBe(
      dispatches[0]
    )
    const context = captured ? f.runtime.createTerminalIdentityReadContext() : undefined
    let evidence: ReturnType<typeof f.runtime.getOrchestrationFleetAgentStatusSnapshot> | undefined
    let failure: unknown
    try {
      evidence = f.runtime.getOrchestrationFleetAgentStatusSnapshot(context)
    } catch (error) {
      failure = error
    }
    try {
      if (fault) {
        expect(failure).toBeInstanceOf(Error)
        expect(String(failure)).toContain('attempt_observation_facts')
        expect(effectOrder).toEqual(raw.slice(0, 2).map((row) => row.paneKey))
      } else {
        expect(failure).toBeUndefined()
        expect(evidence?.[0].binding).toMatchObject({ kind: 'worker', dispatchId: 'ingestion-0' })
        expect(evidence?.[1].binding).toMatchObject({ kind: 'worker', dispatchId: dispatches[1] })
        expect(evidence?.[2].binding).toEqual({ kind: 'unresolved', reason: 'stale_incarnation' })
        expect(evidence?.[5].binding.kind).toBe('pane')
        // Default IPC still acquires the full public context, including attention.
        expect(enrichAgentStatusIpcPayload(raw[0], f.runtime).orchestration).toMatchObject({
          dispatchId: dispatches[0],
          attention: expect.any(Object)
        })
      }
      const normalize = (value: unknown) => {
        let text = JSON.stringify(value)
        for (let i = 0; i < dispatches.length; i++) {
          text = text.replaceAll(dispatches[i], `current-${i}`)
        }
        return JSON.parse(text)
      }
      return {
        evidence: normalize(evidence ?? null),
        state: f.state(),
        effectOrder,
        error: String(failure)
      }
    } finally {
      db.close()
    }
  }
  try {
    for (const fault of [false, true]) {
      expect(run(true, fault)).toEqual(run(false, fault))
    }
  } finally {
    vi.useRealTimers()
  }
})

it('keeps the real OSC hook producer and observation owner authoritative after a newer current Dispatch', () => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
  const run = (captured: boolean) => {
    const server = new AgentHookServer()
    const observations = new AgentStatusObservedPaneIdentities()
    const f = fixture(
      agentHookRuntimeDeps(server, observations, () => ({ agentStatusHooksEnabled: false }))
    )
    const detach = f.runtime.attachAgentStatusStore(server)
    const stop = server.subscribeEnrichedStatus((event) =>
      recordObservedAgentStatusPaneIdentity(observations, event, f.runtime)
    )
    const db = new OrchestrationDb(':memory:')
    f.runtime.setOrchestrationDb(db)
    f.add('hook-pty', 'term_hook', PANE)
    f.owner.recordPtyWorktree('hook-pty', TEST_WORKTREE_ID, { incarnationId: 'hook-process' })
    f.stamp('term_hook', 'hook-pty')
    const group = db.createRun({
      objective: 'Observed',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: PANE
    })
    const assign = () =>
      db.createDispatchContext({
        taskId: db.createTask({ runId: group.id, spec: 'Hook contract' }).id,
        assigneeHandle: 'term_hook',
        assigneePaneKey: PANE,
        processIncarnation: 'hook-pty:hook-process',
        creator: { kind: 'system' },
        maxDepth: 10
      })
    try {
      const first = assign()
      f.runtime.onPtyData(
        'hook-pty',
        '\x1b]9999;{"state":"working","prompt":"busy","agentType":"codex"}\x07',
        1_800_000_000_000
      )
      expect(server.getStatusSnapshot()).toHaveLength(1)
      expect(observations.read(PANE)).toMatchObject({ kind: 'observed', dispatchId: first.id })
      db.completeDispatch(first.id)
      const second = assign()
      expect(f.runtime.getAgentStatusOrchestrationContextForPaneKey(PANE)?.dispatchId).toBe(
        second.id
      )
      const evidence = f.runtime.getOrchestrationFleetAgentStatusSnapshot(
        captured ? f.runtime.createTerminalIdentityReadContext() : undefined
      )
      expect(evidence[0].binding).toMatchObject({
        kind: 'worker',
        dispatchId: first.id,
        processIncarnation: 'hook-pty:hook-process'
      })
      return evidence.map((row) => ({
        ...row,
        binding:
          row.binding.kind === 'worker'
            ? { ...row.binding, dispatchId: '<ingestion>' }
            : row.binding
      }))
    } finally {
      stop()
      detach()
      db.close()
    }
  }
  try {
    expect(run(true)).toEqual(run(false))
  } finally {
    vi.useRealTimers()
  }
})

it('forwards finite context through actual live-pane nested-recipient reads with unchanged repair and disconnected outcomes', () => {
  const measure = (population: number, captured: boolean) => {
    const f = fixture()
    for (let i = 0; i < population; i++) {
      f.add(`nested-${i}`, `term_nested_${i}`, `pane-${i}`, i !== 0)
      f.stamp(`term_nested_${i}`, `nested-${i}`)
    }
    // The stale first reverse mapping and missing targets exercise the second live-leaf acquisition.
    f.owner.source.bindPty('stale-missing', 'term_stale')
    const counts = { entries: 0, get: 0, set: 0, delete: 0 }
    countIterations(f.owner.handles, counts)
    countIterations(f.owner.handleByPtyId, counts)
    countIterations(f.owner.ptysById, counts)
    countIterations(f.owner.leaves, counts)
    const context = captured ? f.runtime.createTerminalIdentityReadContext() : undefined
    const output: (string | null)[] = []
    for (let i = 0; i < population; i++) {
      output.push(f.runtime.getLiveTerminalPaneKey(`term_nested_${i}`, context))
      output.push(f.runtime.getLiveTerminalPaneKey(`term_missing_${i}`, context))
    }
    output.push(f.runtime.getLiveTerminalPaneKey('term_stale', context))
    expect(output[0]).toBeNull()
    expect(output[2]).toBe('pane-1')
    expect(output.at(-1)).toBeNull()
    return { output, state: f.state(), counts }
  }
  const samples = [3, 30].map((population) => {
    const old = measure(population, false)
    const current = measure(population, true)
    expect(current.output).toEqual(old.output)
    expect(current.state).toEqual(old.state)
    return { old: old.counts, current: current.counts }
  })
  expect(samples[1].current.entries).toBeLessThanOrEqual(10 * samples[0].current.entries + 30)
  expect(samples[1].old.entries).toBeGreaterThan(20 * samples[0].old.entries)
  process.stdout.write(`nested live-pane ordered work ${JSON.stringify(samples)}\n`)
})
