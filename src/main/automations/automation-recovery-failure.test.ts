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

let service: AutomationService | undefined

afterEach(async () => {
  service?.stop()
  vi.restoreAllMocks()
  await closeTestStores()
  vi.useRealTimers()
  rmSync(testState.dir, { recursive: true, force: true })
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
