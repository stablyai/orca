import { describe, expect, it, vi } from 'vitest'
import { AutomationService } from './service'
import type { HeadlessAutomationDispatchLaunch } from './headless-dispatch'
import * as automationContext from '../persistence/scheduling-automations/automation-context-migration'
import { captureOutcomeLifetime } from './automation-outcome-lifetime.test-fixture'
import { createAutomationRunWriter } from './automation-run-writer'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

async function runningFixture() {
  const result = await fixture()
  const automation = result.store.listAutomations()[0]
  const run = result.store.createAutomationRun(automation, 1_800_000_000_000, 'manual')
  result.store.updateAutomationRun({ runId: run.id, status: 'dispatched' })
  await result.store.flushPendingOrThrowAsync()
  const publish = vi.fn()
  const { owner: writer, pendingIds } = captureOutcomeLifetime(() =>
    createAutomationRunWriter(result.store, publish)
  )
  return { ...result, run, publish, writer, pendingIds }
}

describe('durable automation outcome publication', () => {
  it('retains a failed-flush intent until an unrelated commit saves it', async () => {
    const { store, authority, run, publish, writer, readState } = await runningFixture()
    const restore = [
      vi
        .spyOn(authority, 'writeSerializedAutomationRuns')
        .mockRejectedValue(new Error('disk full')),
      vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValue(new Error('disk full')),
      vi
        .spyOn(authority, 'writeCompleteSerializedDomains')
        .mockRejectedValue(new Error('disk full')),
      vi.spyOn(authority, 'writeSerializedState').mockRejectedValue(new Error('disk full'))
    ]
    await expect(writer.updateRun({ runId: run.id, status: 'dispatch_failed' })).rejects.toThrow(
      'disk full'
    )
    expect(
      publish.mock.calls.flatMap(([event]) => (event.settledRun ? [event.settledRun] : []))
    ).toEqual([])
    expect(readState().automationRuns.find((row: { id: string }) => row.id === run.id).status).toBe(
      'dispatched'
    )

    for (const spy of restore) {
      spy.mockRestore()
    }
    store.updateUI({ activeView: 'automations' })
    await store.flushPendingOrThrowAsync()
    expect(readState().automationRuns.find((row: { id: string }) => row.id === run.id).status).toBe(
      'dispatch_failed'
    )
    expect(
      publish.mock.calls.flatMap(([event]) =>
        event.settledRun ? [event.settledRun.run.status] : []
      )
    ).toEqual(['dispatch_failed'])
    await writer.updateRun({ runId: run.id, status: 'dispatch_failed', terminalPtyId: null })
    expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(1)
    writer.dispose()
  })

  it('keeps the captured outcome through a concurrent final-row metadata rewrite', async () => {
    const { store, authority, run, publish, writer } = await runningFixture()
    const gate = authority.pause()
    const final = writer.updateRun({ runId: run.id, status: 'completed' })
    await gate.started.promise
    const metadata = writer.updateRun({ runId: run.id, status: 'completed', terminalPtyId: null })
    expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(0)
    gate.finish.resolve()
    await Promise.all([final, metadata])
    const outcomes = publish.mock.calls.flatMap(([event]) =>
      event.settledRun ? [event.settledRun] : []
    )
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].run).toMatchObject({ id: run.id, status: 'completed' })
    expect(store.listAutomationRuns().find((row) => row.id === run.id)?.terminalPtyId).toBeNull()
    writer.dispose()
  })

  it.each(['deleted', 'pruned', 'disposed'] as const)(
    'releases a pending intent when %s',
    async (release) => {
      const { store, authority, run, publish, writer, pendingIds } = await runningFixture()
      const restore = [
        vi
          .spyOn(authority, 'writeSerializedAutomationRuns')
          .mockRejectedValue(new Error('disk full')),
        vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValue(new Error('disk full')),
        vi
          .spyOn(authority, 'writeCompleteSerializedDomains')
          .mockRejectedValue(new Error('disk full')),
        vi.spyOn(authority, 'writeSerializedState').mockRejectedValue(new Error('disk full'))
      ]
      await expect(writer.updateRun({ runId: run.id, status: 'dispatch_failed' })).rejects.toThrow(
        'disk full'
      )
      for (const spy of restore) {
        spy.mockRestore()
      }
      expect(pendingIds()).toEqual([run.id])
      if (release === 'deleted') {
        store.deleteAutomation(run.automationId)
      } else if (release === 'pruned') {
        let now = 1_800_000_000_001
        vi.spyOn(Date, 'now').mockImplementation(() => now++)
        const automation = store.listAutomations().find((row) => row.id === run.automationId)!
        for (let index = 0; index < 101; index++) {
          const newer = store.createAutomationRun(automation, 1_800_000_001_000 + index, 'manual')
          store.updateAutomationRun({ runId: newer.id, status: 'completed' })
        }
        expect(store.hasAutomationRun(run.id)).toBe(false)
      } else {
        writer.dispose()
      }
      expect(pendingIds()).toEqual([])
      await store.flushPendingOrThrowAsync()
      expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(0)
      writer.dispose()
    }
  )
})

it.each([1_000, 10_000])(
  'does no history work on idle durable commits with %i retained rows',
  async (size) => {
    const { store } = await fixture(undefined, {}, (initial) => {
      const automation = initial.automations[0]
      const run = initial.automationRuns[0]
      initial.automations = Array.from({ length: size / 100 }, (_, index) => ({
        ...automation,
        id: `automation-${index}`
      }))
      initial.automationRuns = Array.from({ length: size }, (_, index) => ({
        ...run,
        id: `run-${index}`,
        automationId: `automation-${Math.floor(index / 100)}`,
        status: 'completed'
      }))
    })
    expect(store.listAutomationRuns()).toHaveLength(size)
    const history = vi.spyOn(store, 'listAutomationRuns')
    const membership = vi.spyOn(store, 'hasAutomationRun')
    const writer = createAutomationRunWriter(store, vi.fn())
    for (let index = 0; index < 3; index++) {
      store.updateSettings({ theme: index % 2 ? 'dark' : 'light' })
      await store.flushPendingOrThrowAsync()
    }
    expect(history).not.toHaveBeenCalled()
    expect(membership).not.toHaveBeenCalled()
    writer.dispose()
  }
)

it('keeps activation and live outcomes atomic when the first complete write fails', async () => {
  const { store, authority, readState, reopen } = await fixture(
    undefined,
    {},
    (initial) => {
      delete initial.automationFailureSeenVersion
      initial.automationRuns[0].status = 'dispatch_failed'
      initial.automationRuns.push({
        ...initial.automationRuns[0],
        id: 'recovered',
        status: 'dispatched'
      })
    },
    false
  )
  const historical = store.listAutomationRuns().find((row) => row.id !== 'recovered')!
  expect(historical.failureSeenAt).toEqual(expect.any(Number))
  const publish = vi.fn()
  const writer = createAutomationRunWriter(store, publish)
  const gate = authority.pause()
  authority.failNextWrite()
  const first = store.flushPendingOrThrowAsync()
  const rejected = expect(first).rejects.toThrow('profile_state_write_failed')
  await gate.started.promise
  const final = writer.updateRun({ runId: 'recovered', status: 'dispatch_failed' })
  store.updateSettings({ theme: 'dark' })
  expect(readState().automationFailureSeenVersion).toBeUndefined()
  expect(
    readState().automationRuns.find((row: { id: string }) => row.id === 'recovered').status
  ).toBe('dispatched')
  expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(0)
  gate.finish.resolve()
  await rejected
  await final
  await store.flushPendingOrThrowAsync()
  const committed = readState()
  expect(committed.automationFailureSeenVersion).toBe(1)
  expect(
    committed.automationRuns.find((row: { id: string }) => row.id === historical.id).failureSeenAt
  ).toBe(historical.failureSeenAt)
  expect(
    committed.automationRuns.find((row: { id: string }) => row.id === 'recovered')
  ).toMatchObject({ status: 'dispatch_failed' })
  expect(
    committed.automationRuns.find((row: { id: string }) => row.id === 'recovered').failureSeenAt
  ).toBeUndefined()
  expect(
    publish.mock.calls.flatMap(([event]) => (event.settledRun ? [event.settledRun.run.id] : []))
  ).toEqual(['recovered'])
  const next = await reopen()
  expect(
    next.listAutomationRuns().find((row) => row.id === 'recovered')?.failureSeenAt
  ).toBeUndefined()
  writer.dispose()
})

it.each([1_000, 10_000])('bounds pending membership work at %i raw rows', async (size) => {
  const { store, authority } = await fixture(undefined, {}, (initial) => {
    const run = initial.automationRuns[0]
    initial.automationRuns = Array.from({ length: size }, (_, index) => ({
      ...run,
      id: `pressure-${index}`,
      status: 'dispatched'
    }))
  })
  const publish = vi.fn()
  const writer = createAutomationRunWriter(store, publish)
  const failures = [
    vi.spyOn(authority, 'writeSerializedAutomationRuns').mockRejectedValue(new Error('disk full')),
    vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValue(new Error('disk full')),
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockRejectedValue(new Error('disk full'))
  ]
  for (let index = 0; index < 10; index++) {
    await expect(
      writer.updateRun({ runId: `pressure-${index}`, status: 'completed' })
    ).rejects.toThrow('disk full')
  }
  for (const failure of failures) {
    failure.mockRestore()
  }
  let rawVisits = 0
  for (const row of store['state'].automationRuns) {
    const id = row.id
    Object.defineProperty(row, 'id', {
      get: () => {
        rawVisits++
        return id
      },
      enumerable: true,
      configurable: true
    })
  }
  const membership = vi.spyOn(store, 'hasAutomationRun')
  const history = vi.spyOn(store, 'listAutomationRuns')
  store.updateSettings({ theme: 'dark' })
  await store.flushPendingOrThrowAsync()
  expect(rawVisits).toBeLessThan(size * 4)
  expect(membership).toHaveBeenCalledTimes(10)
  expect(history).not.toHaveBeenCalled()
  expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(10)
  const settled = rawVisits
  store.updateSettings({ theme: 'light' })
  await store.flushPendingOrThrowAsync()
  expect(membership).toHaveBeenCalledTimes(10)
  expect(rawVisits - settled).toBeLessThan(size * 3)
  writer.dispose()
})

it('loads the committed receipt before a lost primary acknowledgement without reseeding live failures', async () => {
  const { store, authority, readState, loadBeforeAck } = await fixture(
    undefined,
    {},
    (initial) => {
      delete initial.automationFailureSeenVersion
      initial.automationRuns[0].status = 'dispatch_failed'
    },
    false
  )
  const automation = store.listAutomations()[0]
  const fresh = store.createAutomationRun(automation, 1_800_000_000_000, 'manual')
  store.updateAutomationRun({ runId: fresh.id, status: 'dispatch_failed' })
  const gate = authority.pause(true)
  const saving = store.flushPendingOrThrowAsync()
  try {
    await gate.started.promise
    expect(readState().automationFailureSeenVersion).toBe(1)
    expect(store.automationDurableWriteGeneration()).toBeLessThan(store.automationWriteGeneration())
    const loaded = loadBeforeAck()
    expect(
      loaded.listAutomationRuns().find((row) => row.id === fresh.id)?.failureSeenAt
    ).toBeUndefined()
    expect(JSON.parse(loaded.prepareProfileStateExport().json).automationFailureSeenVersion).toBe(1)
    loaded.freezeWrites()
  } finally {
    gate.finish.resolve()
    await saving
  }
})

it.each([
  [100, 10],
  [1_000, 10],
  [1_000, 100]
])(
  'captures exact metadata without catalog work at A=%i P=%i through failed-save recovery',
  async (definitions, transitions) => {
    const { store, authority } = await fixture(undefined, {}, (initial) => {
      const definition = initial.automations[0]
      const run = initial.automationRuns[0]
      initial.automations = Array.from({ length: definitions }, (_, i) => ({
        ...definition,
        id: `definition-${i}`,
        name: `Captured ${i}`
      }))
      initial.automationRuns = Array.from({ length: 1_000 }, (_, i) => ({
        ...run,
        id: `metadata-${i}`,
        automationId: `definition-${i % definitions}`,
        status: 'dispatched'
      }))
    })
    const catalogs = vi.spyOn(store, 'listAutomations')
    const normalizations = vi.spyOn(automationContext, 'normalizeAutomationSessionReuse')
    const publish = vi.fn()
    const { owner: writer, pendingIds } = captureOutcomeLifetime(() =>
      createAutomationRunWriter(store, publish)
    )
    const failures = [
      vi
        .spyOn(authority, 'writeSerializedAutomationRuns')
        .mockRejectedValue(new Error('disk full')),
      vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValue(new Error('disk full')),
      vi
        .spyOn(authority, 'writeCompleteSerializedDomains')
        .mockRejectedValue(new Error('disk full')),
      vi.spyOn(authority, 'writeSerializedState').mockRejectedValue(new Error('disk full'))
    ]
    try {
      for (let i = 0; i < transitions; i++) {
        await expect(
          writer.updateRun({
            runId: `metadata-${i}`,
            status: i % 2 ? 'completed' : 'dispatch_failed'
          })
        ).rejects.toThrow('disk full')
      }
      expect(catalogs).not.toHaveBeenCalled()
      expect(normalizations).not.toHaveBeenCalled()
      expect(pendingIds()).toHaveLength(transitions)
      const originalAgent = store['state'].automations[0].agentId
      store.updateAutomation('definition-0', { name: 'Renamed after capture', agentId: 'codex' })
      await expect(
        writer.updateRun({
          runId: 'metadata-0',
          status: 'dispatch_failed',
          terminalPtyId: null,
          outputSnapshot: {
            format: 'plain_text',
            content: 'later output',
            capturedAt: 1_800_000_000_000,
            truncated: false
          },
          usage: {
            status: 'unavailable',
            provider: null,
            model: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningOutputTokens: null,
            totalTokens: null,
            estimatedCostUsd: null,
            estimatedCostSource: null,
            providerSessionId: null,
            attribution: null,
            collectedAt: 1_800_000_000_000,
            unavailableReason: 'no_matching_session',
            unavailableMessage: null
          }
        })
      ).rejects.toThrow('disk full')
      expect(pendingIds()).toHaveLength(transitions)
      expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(0)
      failures.forEach((failure) => failure.mockRestore())
      store.updateSettings({ theme: 'dark' })
      await store.flushPendingOrThrowAsync()
      const outcomes = publish.mock.calls.flatMap(([event]) =>
        event.settledRun ? [event.settledRun] : []
      )
      expect(outcomes).toHaveLength(transitions)
      expect(outcomes.find((outcome) => outcome.run.id === 'metadata-0')).toMatchObject({
        name: 'Captured 0',
        agentId: originalAgent
      })
      expect(pendingIds()).toEqual([])
      await writer.updateRun({
        runId: 'metadata-0',
        status: 'dispatch_failed',
        terminalPtyId: null
      })
      store.markAutomationRunSeen('definition-0', 'metadata-0')
      await store.flushPendingOrThrowAsync()
      expect(catalogs).not.toHaveBeenCalled()
      expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(transitions)
    } finally {
      failures.forEach((failure) => failure.mockRestore())
      writer.dispose()
    }
  }
)

it.each([10, 100])(
  'retires deleted and pruned pending payloads during an outage at P=%i',
  async (size) => {
    const { store, authority } = await fixture(undefined, {}, (initial) => {
      const definition = initial.automations[0]
      const run = initial.automationRuns[0]
      initial.automations = ['delete', 'prune', 'retained'].map((id) => ({ ...definition, id }))
      initial.automationRuns = ['delete', 'prune', 'retained'].flatMap((kind) =>
        Array.from({ length: kind === 'retained' ? 1 : size }, (_, i) => ({
          ...run,
          id: `${kind}-${i}`,
          automationId: kind,
          status: 'dispatched',
          createdAt: 1_800_000_000_000 + i
        }))
      )
    })
    const publish = vi.fn()
    const durable = vi.spyOn(store, 'onDurableWrite')
    const removals = vi.spyOn(store, 'observeAutomationRunRemovals')
    const { owner: writer, pendingIds } = captureOutcomeLifetime(() =>
      createAutomationRunWriter(store, publish)
    )
    const failures = [
      vi
        .spyOn(authority, 'writeSerializedAutomationRuns')
        .mockRejectedValue(new Error('disk full')),
      vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValue(new Error('disk full')),
      vi
        .spyOn(authority, 'writeCompleteSerializedDomains')
        .mockRejectedValue(new Error('disk full')),
      vi.spyOn(authority, 'writeSerializedState').mockRejectedValue(new Error('disk full'))
    ]
    try {
      for (const id of store.listAutomationRuns().map((run) => run.id)) {
        await expect(writer.updateRun({ runId: id, status: 'completed' })).rejects.toThrow(
          'disk full'
        )
      }
      expect(pendingIds()).toHaveLength(2 * size + 1)
      store.deleteAutomation('delete')
      expect(pendingIds()).toHaveLength(size + 1)
      vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
      const definition = store.listAutomations().find((row) => row.id === 'prune')!
      for (let i = 0; i < 101; i++) {
        const run = store.createAutomationRun(definition, 1_900_000_000_000 + i, 'manual')
        store.updateAutomationRun({ runId: run.id, status: 'completed' })
      }
      expect(pendingIds()).toEqual(['retained-0'])
      await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('disk full')
      expect(pendingIds()).toEqual(['retained-0'])
      expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(0)
      failures.forEach((failure) => failure.mockRestore())
      store.updateSettings({ theme: 'dark' })
      await store.flushPendingOrThrowAsync()
      expect(pendingIds()).toEqual([])
      expect(
        publish.mock.calls.flatMap(([event]) => (event.settledRun ? [event.settledRun.run.id] : []))
      ).toEqual(['retained-0'])
      expect(durable).toHaveBeenCalledOnce()
      expect(removals).toHaveBeenCalledOnce()
      const callbacks = [...store['runtime'].durableWriteListeners]
      writer.dispose()
      expect(store['runtime'].durableWriteListeners.size).toBe(callbacks.length - 2)
      store.updateSettings({ theme: 'light' })
      await store.flushPendingOrThrowAsync()
      expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(1)
    } finally {
      failures.forEach((failure) => failure.mockRestore())
      writer.dispose()
    }
  }
)

it.each([
  ['launch rejection', false],
  ['launch rejection', true],
  ['accepted completion', false],
  ['accepted completion', true]
] as const)(
  'settles real service %s with stopped publication owner=%s without retained obligations',
  async (path, stopped) => {
    const { store, authority, readState } = await fixture()
    const automation = store.createAutomation({
      name: 'Lifetime',
      prompt: 'go',
      agentId: 'codex',
      projectId: store.getRepos()[0].id,
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1_800_000_000_000
    })
    const launch = Promise.withResolvers<HeadlessAutomationDispatchLaunch>()
    const completion = Promise.withResolvers<{ status: 'completed' }>()
    const dispatcher = vi.fn(() => launch.promise)
    const publish = vi.fn()
    const before = store['runtime'].durableWriteListeners.size
    const { owner: service, pendingIds } = captureOutcomeLifetime(
      () =>
        new AutomationService(store, {
          headlessDispatcher: dispatcher,
          onAutomationsChanged: publish
        })
    )
    const running = service.runNow(automation.id)
    await vi.waitFor(() => expect(dispatcher).toHaveBeenCalledOnce())
    if (path === 'accepted completion') {
      launch.resolve({
        workspaceId: 'lifetime-workspace',
        terminalSessionId: null,
        completion: completion.promise
      })
      await running
    }
    if (stopped) {
      service.stop()
      expect(store['runtime'].durableWriteListeners.size).toBe(before)
    }
    const flush = vi.spyOn(store, 'flushPendingOrThrowAsync')
    const gate = authority.pause()
    if (path === 'launch rejection') {
      launch.reject(new Error('provider launch failed'))
    } else {
      completion.resolve({ status: 'completed' })
    }
    await gate.started.promise
    const run = store.listAutomationRuns(automation.id)[0]
    try {
      expect(run.status).toBe(path === 'launch rejection' ? 'dispatch_failed' : 'completed')
      // The live control proves this seam observes the actual writer map, even before any commit.
      expect(pendingIds()).toEqual(stopped ? [] : [run.id])
    } finally {
      gate.finish.resolve()
    }
    await running
    await vi.waitFor(() =>
      expect(
        readState().automationRuns.find((row: { id: string }) => row.id === run.id)?.status
      ).toBe(run.status)
    )
    await store.flushPendingOrThrowAsync()
    expect(flush).toHaveBeenCalled()
    expect(pendingIds()).toEqual([])
    expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(stopped ? 0 : 1)
    expect(publish.mock.calls.some(([event]) => event.reason === 'run' && !event.settledRun)).toBe(
      true
    )
    service.stop()
    expect(store['runtime'].durableWriteListeners.size).toBe(before)
  }
)
