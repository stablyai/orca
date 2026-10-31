import { describe, expect, it, vi } from 'vitest'
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
  const writer = createAutomationRunWriter(result.store, publish)
  return { ...result, run, publish, writer }
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
      const { store, authority, run, publish, writer } = await runningFixture()
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
      await store.flushPendingOrThrowAsync()
      expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(0)
      writer.dispose()
    }
  )
})

it.each([1_000, 10_000])(
  'does no history work on idle durable commits with %i retained rows',
  async (size) => {
    const { store } = await fixture(undefined, (initial) => {
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
  const { store, authority } = await fixture(undefined, (initial) => {
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
