import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState,
  readPersistedState,
  writeDataFile
} from '../persistence/persistence-test-harness'
import { AutomationService } from './automation-service'

let service: AutomationService | undefined

afterEach(async () => {
  service?.stop()
  vi.restoreAllMocks()
  await closeTestStores()
  vi.useRealTimers()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('quarantines an invalid historical rule without consuming valid scheduled slots', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-invalid-recovery-'))
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-11-23T00:00:00Z'))
  const store = createStore({ storageAuthority: 'runtime' })
  store.addRepo(makeRepo({ path: testState.dir }))
  const automation = store.createAutomation({
    name: 'invalid checkpoint',
    prompt: 'Do nothing',
    agentId: 'codex',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '* * * * *',
    dtstart: Date.now(),
    enabled: true,
    precheck: { command: 'exit 1', timeoutSeconds: 5 }
  })
  vi.setSystemTime(new Date('2026-11-23T10:00:00Z'))
  store.recordMissedAutomationOccurrences(automation, Date.now())
  store.advanceAutomationNextRun(automation.id, Date.now())
  await store.flushPendingOrThrowAsync()
  const saved = readPersistedState()
  saved.automationRuns[0].missedOccurrenceRecovery!.rrule = 'FREQ=NO_LONGER_SUPPORTED'
  await closeTestStores()
  writeDataFile({
    ...saved,
    automations: saved.automations.map((entry) => ({
      ...entry,
      missedOccurrenceRecoveries: { ...saved.automationRuns[0].missedOccurrenceRecovery }
    }))
  })
  let reopened = createStore({ storageAuthority: 'runtime' })
  const launcher = {
    available: () => true,
    launch: async (): Promise<never> => {
      throw new Error('precheck must prevent agent launch')
    }
  }
  vi.setSystemTime(new Date('2026-11-23T10:01:00Z'))
  service = new AutomationService(reopened, { terminalLauncher: launcher })
  service.start()
  await vi.waitFor(() =>
    expect(
      reopened
        .listAutomationRuns(automation.id)
        .find((run) => run.scheduledFor === Date.parse('2026-11-23T10:01:00Z'))?.precheckResult
        ?.exitCode
    ).toBe(1)
  )
  service.stop()
  await closeTestStores()
  reopened = createStore({ storageAuthority: 'runtime' })
  const partial = reopened
    .listAutomationRuns(automation.id)
    .find((run) => run.status === 'skipped_missed')!
  expect([
    partial.occurrenceCount,
    partial.lastOccurrenceAt,
    partial.missedOccurrenceRecovery?.failure
  ]).toEqual([256, Date.parse('2026-11-23T04:16:00Z'), 'Unsupported automation recurrence.'])
  expect(reopened.listAutomations()[0].nextRunAt).toBe(Date.parse('2026-11-23T10:02:00Z'))
  expect(reopened.listAutomations()[0].missedOccurrenceRecoveries).toBeUndefined()
  vi.setSystemTime(new Date('2026-11-23T10:02:00Z'))
  service = new AutomationService(reopened, { terminalLauncher: launcher })
  service.start()
  await vi.waitFor(() =>
    expect(
      reopened
        .listAutomationRuns(automation.id)
        .find((run) => run.scheduledFor === Date.parse('2026-11-23T10:02:00Z'))?.precheckResult
        ?.exitCode
    ).toBe(1)
  )
  expect(
    reopened
      .listAutomationRuns(automation.id)
      .map((run) => run.status)
      .sort()
  ).toEqual(['skipped_missed', 'skipped_precheck', 'skipped_precheck'])
})

it('preserves the future slot across a failed recovery barrier and a restart', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-recovery-failure-'))
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-11-23T00:00:00Z'))
  const store = createStore({ storageAuthority: 'runtime' })
  store.addRepo(makeRepo())
  const automation = store.createAutomation({
    name: 'recovery failure',
    prompt: 'Do nothing',
    agentId: 'codex',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '* * * * *',
    dtstart: Date.now(),
    enabled: true
  })
  vi.setSystemTime(new Date('2026-11-23T10:00:00Z'))
  store.recordMissedAutomationOccurrences(automation, Date.now())
  store.advanceAutomationNextRun(automation.id, Date.now())
  await store.flushPendingOrThrowAsync()
  vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(
    new Error('recovery write failed')
  )
  service = new AutomationService(store, { tickMs: 1000 })
  service.start()
  await vi.advanceTimersByTimeAsync(1000)
  await store.flushPendingOrThrowAsync()
  expect(
    store.listAutomationRuns(automation.id).map((run) => [run.status, run.scheduledFor])
  ).toEqual([['skipped_missed', Date.parse('2026-11-23T00:01:00Z')]])
  service.stop()
  await closeTestStores()
  const reopened = createStore({ storageAuthority: 'runtime' })
  expect(reopened.listAutomations()[0].nextRunAt).toBe(Date.parse('2026-11-23T10:01:00Z'))
  vi.setSystemTime(new Date('2026-11-23T10:01:00Z'))
  service = new AutomationService(reopened, { tickMs: 1000 })
  service.start()
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() =>
    expect(
      reopened
        .listAutomationRuns(automation.id)
        .find((run) => run.scheduledFor === Date.parse('2026-11-23T10:01:00Z'))?.errorCode
    ).toBe('noDispatchHost')
  )
})

it('persists an empty sparse batch without losing its remaining occurrences or delaying the latest', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-empty-recovery-'))
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-01-30T00:00:00Z'))
  let store = createStore({ storageAuthority: 'runtime' })
  store.addRepo(makeRepo({ path: testState.dir }))
  const automation = store.createAutomation({
    name: 'day 31',
    prompt: 'Do nothing',
    agentId: 'codex',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: '0 9 31 * *',
    dtstart: Date.now(),
    enabled: true,
    precheck: { command: 'exit 1', timeoutSeconds: 5 }
  })
  vi.setSystemTime(new Date('2026-01-31T09:00:00Z'))
  store.createAutomationRun(automation, Date.now())
  vi.setSystemTime(new Date('2026-07-31T09:00:00Z'))
  const launcher = {
    available: () => true,
    launch: async (): Promise<never> => {
      throw new Error('precheck must prevent agent launch')
    }
  }
  service = new AutomationService(store, { terminalLauncher: launcher })
  service.start()
  await vi.waitFor(() =>
    expect(
      store
        .listAutomationRuns(automation.id)
        .find((run) => run.scheduledFor === Date.parse('2026-07-31T09:00:00Z'))?.precheckResult
        ?.exitCode
    ).toBe(1)
  )
  service.stop()
  await closeTestStores()
  store = createStore({ storageAuthority: 'runtime' })
  expect(store.listAutomations()[0].nextRunAt).toBe(Date.parse('2026-08-31T09:00:00Z'))
  expect(
    store
      .listAutomations()[0]
      .missedOccurrenceRecoveries?.map((recovery) => [
        recovery.nextAt,
        recovery.before,
        recovery.rrule
      ])
  ).toEqual([
    [Date.parse('2026-03-31T09:00:00Z'), Date.parse('2026-07-31T09:00:00Z'), '0 9 31 * *']
  ])
  expect(
    store
      .listAutomationRuns(automation.id)
      .map((run) => run.status)
      .sort()
  ).toEqual(['pending', 'skipped_precheck'])
  store.updateAutomation(automation.id, { enabled: false })
  store.updateAutomation(automation.id, { enabled: true })
  store.updateAutomation(automation.id, { rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0' })
  service = new AutomationService(store, { terminalLauncher: launcher, tickMs: 1000 })
  service.start()
  await vi.waitFor(() =>
    expect(store.listAutomations()[0].missedOccurrenceRecoveries).toBeUndefined()
  )
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() =>
    expect(
      store.listAutomationRuns(automation.id).find((run) => run.status === 'skipped_missed')
        ?.occurrenceCount
    ).toBe(2)
  )
  const missed = store
    .listAutomationRuns(automation.id)
    .find((run) => run.status === 'skipped_missed')!
  expect([missed.scheduledFor, missed.lastOccurrenceAt, missed.missedOccurrenceRecovery]).toEqual([
    Date.parse('2026-03-31T09:00:00Z'),
    Date.parse('2026-05-31T09:00:00Z'),
    undefined
  ])
  expect(store.listAutomations()[0].nextRunAt).toBe(Date.parse('2026-07-31T10:00:00Z'))
  expect(
    store
      .listAutomationRuns(automation.id)
      .map((run) => run.status)
      .sort()
  ).toEqual(['pending', 'skipped_missed', 'skipped_precheck'])
})
