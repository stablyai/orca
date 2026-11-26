import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repository/repo-types'
import { AutomationService } from './automation-service'
import { createAwakeClock, type AwakeClock } from '../power/awake-clock'
import { automationSystemSettled } from './dispatch/automation-wake-settle'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const TICK_MS = 60_000

const makeRepo = (): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
})

describe('missed-run grace after a wake (daily 09:00 run, 60 min grace)', () => {
  let clock: AwakeClock
  /** Sleep the fake monotonic counter missed: fake performance only moves with timers. */
  let countedSleep = 0

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-wake-test-'))
    vi.useFakeTimers({
      toFake: [
        'Date',
        'performance',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate'
      ]
    })
    // Why: offset-less times are local, matching the schedule's local BYHOUR in any CI TZ.
    vi.setSystemTime(new Date('2026-11-09T08:00:00'))
    countedSleep = 0
    clock = createAwakeClock({
      wallNow: () => Date.now(),
      monotonicNow: () => performance.now() + countedSleep,
      after: (beat, ms) => {
        setTimeout(beat, ms)
      }
    })
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function awakeFor(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
  }

  /** Asleep: no timers run; the wall clock and the macOS monotonic counter move on. */
  function asleepUntil(when: string): void {
    const ms = new Date(when).getTime() - Date.now()
    vi.setSystemTime(Date.now() + ms)
    countedSleep += ms
  }

  /** Wakes at `when` and stays awake past the settle wait and one more tick. */
  async function wakeAndSettle(when: string): Promise<void> {
    asleepUntil(when)
    clock.resume()
    await awakeFor(5 * TICK_MS)
  }

  async function scheduledService() {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Daily health report',
      prompt: 'Report',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::wt1',
      timezone: 'America/Los_Angeles',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-11-08T00:00:00').getTime(),
      missedRunGraceMinutes: 60
    })
    const launch = vi.fn(async () => ({ workspaceId: 'wt-1', terminalSessionId: 'tab-1' }))
    const service = new AutomationService(store, {
      terminalLauncher: { launch, available: () => true }
    })
    service.wakeGate.settled = () => automationSystemSettled(clock)
    const statuses = () => store.listAutomationRuns(automation.id).map((run) => run.status)
    return { launch, service, statuses }
  }

  it('skips a run when its only wakes inside grace were dark wakes and the real wake is a day later', async () => {
    const { launch, service, statuses } = await scheduledService()
    service.start()
    await awakeFor(TICK_MS)
    clock.suspend()

    // Two dark wakes inside grace, each shorter than the settle wait.
    asleepUntil('2026-11-09T09:10:00')
    await awakeFor(TICK_MS + 1_000)
    asleepUntil('2026-11-09T09:40:00')
    await awakeFor(TICK_MS + 1_000)

    await wakeAndSettle('2026-11-10T08:00:00')

    expect(statuses()).toEqual(['skipped_missed'])
    expect(launch).not.toHaveBeenCalled()
    service.stop()
  })

  it('credits the whole wait when the overdue tick fires before the resume event', async () => {
    const { launch, service, statuses } = await scheduledService()
    service.start()
    await awakeFor(2 * TICK_MS - 1_000)
    clock.suspend()

    // The lid opens at 10:01:30 and the overdue tick fires before resume is delivered, so
    // the settle wait ends a tick later, at 10:04:30.
    asleepUntil('2026-11-09T10:01:29')
    await awakeFor(1_500)
    clock.resume()
    await awakeFor(5 * TICK_MS)

    await vi.waitFor(() => expect(statuses()).toEqual(['dispatched']))
    expect(launch).toHaveBeenCalledOnce()
    service.stop()
  })
})
