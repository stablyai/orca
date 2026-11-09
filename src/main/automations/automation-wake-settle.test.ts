import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import { AutomationService } from './service'
import { TICK_MS } from './automation-service-tick.test-fixture'
import { createAwakeClock, type AwakeClock } from '../power/awake-clock'
import { AUTOMATION_WAKE_SETTLE_MS, automationSystemSettled } from './automation-wake-settle'

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

const makeRepo = (): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
})

describe('scheduled catch-up after a wake', () => {
  let clock: AwakeClock

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-wake-test-'))
    // Fake performance advances with timers but not with setSystemTime, as a sleeping machine's
    // monotonic clock stands still while its wall clock moves on.
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
    vi.setSystemTime(new Date('2026-11-09T08:00:00-08:00'))
    clock = createAwakeClock({
      wallNow: () => Date.now(),
      monotonicNow: () => performance.now()
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

  /** Asleep: no timers run and the monotonic clock stands still. */
  function asleepFor(ms: number): void {
    vi.setSystemTime(Date.now() + ms)
  }

  async function scheduledService() {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'GitHub i18n issue and PR scan',
      prompt: 'Scan',
      agentId: 'codex',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::wt1',
      timezone: 'America/Los_Angeles',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-11-08T00:00:00-08:00').getTime(),
      missedRunGraceMinutes: 720
    })
    const launch = vi.fn(async () => ({ workspaceId: 'wt-1', terminalSessionId: 'tab-1' }))
    const service = new AutomationService(store, {
      tickMs: TICK_MS,
      terminalLauncher: { launch, available: () => true }
    })
    service.systemSettled = () => automationSystemSettled(clock)
    service.start()
    await awakeFor(TICK_MS)
    return { store, automation, launch, service }
  }

  it('does not start a missed run during a dark wake, then catches it up once awake and stable', async () => {
    const { store, automation, launch, service } = await scheduledService()

    // The machine sleeps through 09:00 and dark-wakes at 09:08:30 with no resume event.
    clock.suspend()
    asleepFor(new Date('2026-11-09T09:08:30-08:00').getTime() - Date.now())
    await awakeFor(2_000)
    expect(store.listAutomationRuns(automation.id)).toEqual([])

    // Back to sleep, then a full wake at 09:19:37.
    asleepFor(665_000)
    clock.resume()
    await awakeFor(TICK_MS)
    expect(store.listAutomationRuns(automation.id)).toEqual([])
    expect(launch).not.toHaveBeenCalled()

    await awakeFor(AUTOMATION_WAKE_SETTLE_MS)
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id).map((run) => run.status)).toEqual([
        'dispatched'
      ])
    )
    expect(store.listAutomationRuns(automation.id)[0]!.scheduledFor).toBe(
      new Date('2026-11-09T09:00:00-08:00').getTime()
    )
    expect(launch).toHaveBeenCalledOnce()
    service.stop()
  })

  it('also waits after a sleep that no power event reported', async () => {
    const { store, automation, service } = await scheduledService()

    asleepFor(new Date('2026-11-09T09:08:30-08:00').getTime() - Date.now())
    await awakeFor(TICK_MS)
    expect(store.listAutomationRuns(automation.id)).toEqual([])

    await awakeFor(AUTOMATION_WAKE_SETTLE_MS)
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id).map((run) => run.status)).toEqual([
        'dispatched'
      ])
    )
    service.stop()
  })

  it('runs an on-time occurrence on a machine that stayed awake', async () => {
    const { store, automation, service } = await scheduledService()
    await awakeFor(new Date('2026-11-09T09:00:30-08:00').getTime() - Date.now())
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id).map((run) => run.status)).toEqual([
        'dispatched'
      ])
    )
    service.stop()
  })
})
