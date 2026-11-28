import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../persistence/persistence-test-harness'
import { AutomationService } from './automation-service'
import { createAutomationRunWriter } from './run-history/run-writer'

let service: AutomationService | undefined

afterEach(async () => {
  service?.stop()
  await closeTestStores()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('retains every superseded slot on restart without replaying it', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-missed-history-'))
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-11-23T15:38:00Z'))
  const store = createStore({ storageAuthority: 'runtime' })
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'miss-multi',
    prompt: 'Do nothing',
    agentId: 'codex',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '*/2 * * * *',
    dtstart: Date.now(),
    enabled: true,
    missedRunGraceMinutes: 30
  })
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  vi.setSystemTime(new Date('2026-11-23T15:46:00Z'))
  const reopened = createStore({ storageAuthority: 'runtime' })
  service = new AutomationService(reopened)
  service.start()
  await vi.advanceTimersByTimeAsync(60_000)
  const history = () =>
    reopened
      .listAutomationRuns(automation.id)
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map((run) => ({
        status: run.status,
        first: new Date(run.scheduledFor).toISOString(),
        count: run.occurrenceCount ?? 1,
        last: new Date(run.lastOccurrenceAt ?? run.scheduledFor).toISOString()
      }))
  const expected = [
    {
      status: 'skipped_unavailable',
      first: '2026-11-23T15:46:00.000Z',
      count: 1,
      last: '2026-11-23T15:46:00.000Z'
    },
    {
      status: 'skipped_missed',
      first: '2026-11-23T15:40:00.000Z',
      count: 3,
      last: '2026-11-23T15:44:00.000Z'
    }
  ]
  await vi.waitFor(() => expect(history()).toEqual(expected))
  service.stop()
  await closeTestStores()
  const restarted = createStore({ storageAuthority: 'runtime' })
  expect(
    restarted
      .listAutomationRuns(automation.id)
      .reduce((n, run) => n + (run.occurrenceCount ?? 1), 0)
  ).toBe(4)
  expect(restarted.listAutomations()[0].nextRunAt).toBe(Date.parse('2026-11-23T15:48:00Z'))
})

it('checkpoints bounded batches with their counts and does not fold across an offline gap', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-missed-batches-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-23T00:00:00Z'))
  let store = createStore({ storageAuthority: 'runtime' })
  store.addRepo(makeRepo())
  const original = store.createAutomation({
    name: 'bounded',
    prompt: 'Do nothing',
    agentId: 'codex',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '* * * * *',
    dtstart: Date.now(),
    enabled: true
  })
  const before = Date.parse('2026-11-23T10:00:00Z')
  vi.setSystemTime(before)
  const runs = createAutomationRunWriter(store, null)
  await Promise.all([runs.recoverMissed(original, before), runs.recoverMissed(original, before)])
  expect(store.listAutomationRuns(original.id).map((run) => run.occurrenceCount)).toEqual([256])
  expect(store.listAutomations()[0].nextRunAt).toBe(before)
  expect(store.listAutomationRuns(original.id)[0].missedOccurrenceRecovery?.nextAt).toBe(
    Date.parse('2026-11-23T04:17:00Z')
  )
  const unavailable = store.createAutomationRun(original, before)
  store.updateAutomationRun({
    runId: unavailable.id,
    status: 'skipped_unavailable',
    error: 'Host offline'
  })
  store.recordRepeatedAutomationSkip(original.id, 'Host offline', before + 60_000)
  expect(
    store.recordRepeatedAutomationSkip(original.id, 'Host offline', before + 600_000)
  ).toBeNull()
  const later = store.createAutomationRun(original, before + 600_000)
  store.updateAutomationRun({
    runId: later.id,
    status: 'skipped_unavailable',
    error: 'Host offline'
  })
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  store = createStore({ storageAuthority: 'runtime' })
  expect(store.recordMissedAutomationOccurrences(original, before)).toBe(false)
  const reopenedRuns = createAutomationRunWriter(store, null)
  const through = Date.parse('2026-11-23T10:11:00Z')
  await reopenedRuns.recoverMissed(store.listAutomations()[0], through)
  await reopenedRuns.recoverMissed(store.listAutomations()[0], through)
  const retained = store
    .listAutomationRuns(original.id)
    .sort((a, b) => a.scheduledFor - b.scheduledFor)
  expect(retained.map((run) => [run.status, run.occurrenceCount ?? 1])).toEqual([
    ['skipped_missed', 599],
    ['skipped_unavailable', 2],
    ['skipped_missed', 8],
    ['skipped_unavailable', 1]
  ])
  expect(store.listAutomations()[0].nextRunAt).toBe(through)
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  store = createStore({ storageAuthority: 'runtime' })
  expect(
    store.listAutomationRuns(original.id).reduce((n, run) => n + (run.occurrenceCount ?? 1), 0)
  ).toBe(610)
})

it('uses the saved RRULE zone through DST and excludes paused and replaced schedules', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-missed-dst-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-31T00:00:00Z'))
  const store = createStore({ storageAuthority: 'runtime' })
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'DST',
    prompt: 'Do nothing',
    agentId: 'codex',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'America/New_York',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.now(),
    enabled: true
  })
  const before = Date.parse('2026-11-03T14:00:00Z')
  vi.setSystemTime(before)
  store.recordMissedAutomationOccurrences(automation, before)
  const [run] = store.listAutomationRuns(automation.id)
  expect([run.scheduledFor, run.lastOccurrenceAt, run.occurrenceCount]).toEqual([
    Date.parse('2026-10-31T13:00:00Z'),
    Date.parse('2026-11-02T14:00:00Z'),
    3
  ])
  store.updateAutomation(automation.id, { enabled: false })
  vi.setSystemTime(new Date('2026-11-09T14:00:00Z'))
  expect(store.recordMissedAutomationOccurrences(store.listAutomations()[0], Date.now())).toBe(
    false
  )
  const enabled = store.updateAutomation(automation.id, { enabled: true })
  expect(enabled.nextRunAt).toBe(Date.parse('2026-11-09T14:00:00Z'))
  const edited = store.updateAutomation(automation.id, { rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0' })
  expect(edited.nextRunAt).toBe(Date.parse('2026-11-09T15:00:00Z'))
  store.deleteAutomation(automation.id)
  expect(store.recordMissedAutomationOccurrences(edited, Date.now())).toBe(false)
  expect(store.listAutomationRuns(automation.id)).toEqual([])
})

it('keeps a fixed 30-day gap through retention without reclassifying live executions', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-missed-retention-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  let store = createStore({ storageAuthority: 'runtime' })
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'long gap',
    prompt: 'Do nothing',
    agentId: 'codex',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '* * * * *',
    dtstart: Date.now(),
    enabled: true
  })
  const resumed = Date.parse('2026-01-31T00:00:00Z')
  vi.setSystemTime(resumed)
  store.recordMissedAutomationOccurrences(automation, resumed)
  for (let tick = 0; tick < 168; tick += 1) {
    const now = resumed + tick * 60_000
    vi.setSystemTime(now)
    const current = store.listAutomations()[0]
    const run = store.createAutomationRun(current, now)
    store.updateAutomationRun({ runId: run.id, status: 'completed' })
    store.advanceAutomationNextRun(current.id, now)
    const next = store.listAutomations()[0]
    store.recordMissedAutomationOccurrences(next, next.nextRunAt)
    if (tick === 100) {
      await store.flushPendingOrThrowAsync()
      await closeTestStores()
      store = createStore({ storageAuthority: 'runtime' })
      expect(
        store.listAutomationRuns(automation.id).find((entry) => entry.missedOccurrenceRecovery)
          ?.missedOccurrenceRecovery?.before
      ).toBe(resumed)
    }
  }
  const history = store.listAutomationRuns(automation.id)
  const missed = history.filter((run) => run.status === 'skipped_missed')
  expect(
    missed.map((run) => [run.scheduledFor, run.lastOccurrenceAt, run.occurrenceCount])
  ).toEqual([[Date.parse('2026-01-01T00:01:00Z'), Date.parse('2026-01-30T23:59:00Z'), 43_199]])
  expect(missed[0].missedOccurrenceRecovery).toBeUndefined()
  expect(history.length).toBe(100)
  expect(history.filter((run) => run.status === 'completed').length).toBe(99)
})

it('normalizes the saved desktop cursor after the host changes time zones', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-missed-travel-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubEnv('TZ', 'UTC')
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
  const store = createStore()
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'travel',
    prompt: 'Do nothing',
    agentId: 'codex',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '0 9 * * *',
    dtstart: Date.now(),
    enabled: true
  })
  vi.stubEnv('TZ', 'America/Los_Angeles')
  const before = Date.parse('2026-11-03T17:00:00Z')
  store.recordMissedAutomationOccurrences(automation, before)
  const [run] = store.listAutomationRuns(automation.id)
  expect([run.scheduledFor, run.lastOccurrenceAt, run.occurrenceCount]).toEqual([
    Date.parse('2026-11-01T17:00:00Z'),
    Date.parse('2026-11-02T17:00:00Z'),
    2
  ])
})
