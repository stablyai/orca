import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import { AutomationService } from './service'
import { TICK_MS } from './automation-service-tick.test-fixture'
import {
  AWAKE_CLOCK_HEARTBEAT_MS,
  AWAKE_CLOCK_IDLE_MS,
  createAwakeClock,
  type AwakeClock
} from '../power/awake-clock'
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

type CounterModel = 'counts sleep (macOS/Windows Node)' | 'stops in sleep (Linux)'

describe.each<CounterModel>(['counts sleep (macOS/Windows Node)', 'stops in sleep (Linux)'])(
  'scheduled catch-up after a wake, on a monotonic counter that %s',
  (model) => {
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
      vi.setSystemTime(new Date('2026-11-09T08:00:00-08:00'))
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

    /** Asleep: no timers run; the wall clock moves on, and so does the counter if it counts sleep. */
    function asleepUntil(when: string): void {
      const ms = new Date(when).getTime() - Date.now()
      vi.setSystemTime(Date.now() + ms)
      if (model === 'counts sleep (macOS/Windows Node)') {
        countedSleep += ms
      }
    }

    async function scheduledService(opts: { tickMs?: number; graceMinutes?: number } = {}) {
      const tickMs = opts.tickMs ?? TICK_MS
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
        missedRunGraceMinutes: opts.graceMinutes ?? 720
      })
      const launch = vi.fn(async () => ({ workspaceId: 'wt-1', terminalSessionId: 'tab-1' }))
      const service = new AutomationService(store, {
        tickMs,
        terminalLauncher: { launch, available: () => true }
      })
      service.wakeGate.settled = () => automationSystemSettled(clock)
      service.start()
      await awakeFor(tickMs)
      const statuses = () => store.listAutomationRuns(automation.id).map((run) => run.status)
      return { store, automation, launch, service, statuses }
    }

    it('does not start a missed run during a dark wake, then catches it up once awake and stable', async () => {
      // A one-second tick runs the scheduler inside the two-second dark wake.
      const { store, automation, launch, service, statuses } = await scheduledService({
        tickMs: 1_000
      })

      // The machine sleeps through 09:00 and dark-wakes at 09:08:30 with no resume event.
      clock.suspend()
      asleepUntil('2026-11-09T09:08:30-08:00')
      await awakeFor(2_000)
      expect(statuses()).toEqual([])

      // Back to sleep, then a full wake at 09:19:37.
      asleepUntil('2026-11-09T09:19:37-08:00')
      clock.resume()
      await awakeFor(AUTOMATION_WAKE_SETTLE_MS - 1_000)
      expect(statuses()).toEqual([])
      expect(launch).not.toHaveBeenCalled()

      await awakeFor(2_000)
      await vi.waitFor(() => expect(statuses()).toEqual(['dispatched']))
      expect(store.listAutomationRuns(automation.id)[0]!.scheduledFor).toBe(
        new Date('2026-11-09T09:00:00-08:00').getTime()
      )
      expect(launch).toHaveBeenCalledOnce()
      service.stop()
    })

    it('also waits after a sleep that no power event reported', async () => {
      const { launch, service, statuses } = await scheduledService({ tickMs: 1_000 })

      asleepUntil('2026-11-09T09:08:30-08:00')
      await awakeFor(2_000)
      expect(statuses()).toEqual([])
      expect(launch).not.toHaveBeenCalled()

      await awakeFor(AUTOMATION_WAKE_SETTLE_MS)
      await vi.waitFor(() => expect(statuses()).toEqual(['dispatched']))
      service.stop()
    })

    it('does not let the wait after a wake use up a zero-minute grace', async () => {
      const { store, automation, service, statuses } = await scheduledService({ graceMinutes: 0 })

      // Without the wait, the 09:01:01 tick would have launched this run inside its grace.
      clock.suspend()
      asleepUntil('2026-11-09T09:00:01-08:00')
      clock.resume()
      await awakeFor(TICK_MS)
      expect(statuses()).toEqual([])

      await awakeFor(TICK_MS)
      await vi.waitFor(() => expect(statuses()).toEqual(['dispatched']))
      expect(store.listAutomationRuns(automation.id)[0]!.scheduledFor).toBe(
        new Date('2026-11-09T09:00:00-08:00').getTime()
      )
      service.stop()
    })

    it('still skips a run that was already past its grace when the machine woke', async () => {
      const { launch, service, statuses } = await scheduledService({ graceMinutes: 0 })

      clock.suspend()
      asleepUntil('2026-11-09T09:03:00-08:00')
      clock.resume()
      await awakeFor(2 * TICK_MS)
      await vi.waitFor(() => expect(statuses()).toEqual(['skipped_missed']))
      expect(launch).not.toHaveBeenCalled()
      service.stop()
    })

    it('keeps an unchanged held occurrence eligible across repeated short wakes', async () => {
      const { service, statuses } = await scheduledService({ graceMinutes: 0 })

      clock.suspend()
      asleepUntil('2026-11-09T09:00:01-08:00')
      clock.resume()
      await awakeFor(TICK_MS)
      // Another short wake: back to sleep before settling, then a full wake.
      clock.suspend()
      asleepUntil('2026-11-09T09:30:00-08:00')
      clock.resume()
      await awakeFor(TICK_MS)
      expect(statuses()).toEqual([])

      await awakeFor(TICK_MS)
      await vi.waitFor(() => expect(statuses()).toEqual(['dispatched']))
      service.stop()
    })

    it('judges a held occurrence by the grace the user set after it was held', async () => {
      const { store, automation, launch, service, statuses } = await scheduledService({
        graceMinutes: 720
      })

      clock.suspend()
      asleepUntil('2026-11-09T09:05:00-08:00')
      clock.resume()
      await awakeFor(TICK_MS)
      expect(statuses()).toEqual([])
      store.updateAutomation(automation.id, { missedRunGraceMinutes: 0 })

      await awakeFor(TICK_MS)
      await vi.waitFor(() => expect(statuses()).toEqual(['skipped_missed']))
      expect(launch).not.toHaveBeenCalled()
      service.stop()
    })

    it('does not keep a held occurrence across a pause', async () => {
      const { store, automation, launch, service, statuses } = await scheduledService({
        graceMinutes: 0
      })
      // Another enabled automation keeps the gate closed (and its holds kept) through the pause.
      store.createAutomation({
        name: 'Nightly',
        prompt: 'Scan',
        agentId: 'codex',
        projectId: 'r1',
        workspaceMode: 'existing',
        workspaceId: 'r1::wt1',
        timezone: 'America/Los_Angeles',
        rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=0',
        dtstart: new Date('2026-11-08T00:00:00-08:00').getTime()
      })

      clock.suspend()
      asleepUntil('2026-11-09T09:00:01-08:00')
      clock.resume()
      await awakeFor(TICK_MS)
      store.updateAutomation(automation.id, { enabled: false })
      clock.suspend()
      asleepUntil('2026-11-09T11:00:00-08:00')
      clock.resume()
      await awakeFor(TICK_MS)
      store.updateAutomation(automation.id, { enabled: true })

      await awakeFor(TICK_MS)
      await vi.waitFor(() => expect(statuses()).toEqual(['skipped_missed']))
      expect(launch).not.toHaveBeenCalled()
      service.stop()
    })

    it('lets the clock heartbeat idle out while no automation is enabled', async () => {
      const beats = vi.fn()
      clock = createAwakeClock({
        wallNow: () => Date.now(),
        monotonicNow: () => performance.now() + countedSleep,
        after: (beat, ms) => {
          setTimeout(() => {
            beats()
            beat()
          }, ms)
        }
      })
      const store = await createStore()
      store.addRepo(makeRepo())
      const service = new AutomationService(store, {
        tickMs: TICK_MS,
        terminalLauncher: { launch: vi.fn(), available: () => true }
      })
      service.wakeGate.settled = () => automationSystemSettled(clock)
      service.start()
      await awakeFor(60 * 60_000)
      expect(beats).not.toHaveBeenCalled()

      // Enabling one restarts it on the next tick.
      const automation = store.createAutomation({
        name: 'Scan',
        prompt: 'Scan',
        agentId: 'codex',
        projectId: 'r1',
        workspaceMode: 'existing',
        workspaceId: 'r1::wt1',
        timezone: 'America/Los_Angeles',
        rrule: 'FREQ=DAILY;BYHOUR=23;BYMINUTE=0',
        dtstart: new Date('2026-11-08T00:00:00-08:00').getTime()
      })
      await awakeFor(TICK_MS + 2 * AWAKE_CLOCK_HEARTBEAT_MS)
      expect(beats).toHaveBeenCalledTimes(2)

      // Pausing it lets the heartbeat stop once the idle window passes.
      store.updateAutomation(automation.id, { enabled: false })
      await awakeFor(AWAKE_CLOCK_IDLE_MS + AWAKE_CLOCK_HEARTBEAT_MS)
      const settledCount = beats.mock.calls.length
      await awakeFor(60 * 60_000)
      expect(beats).toHaveBeenCalledTimes(settledCount)
      service.stop()
    })

    it('runs an on-time occurrence on a machine that stayed awake', async () => {
      const { service, statuses } = await scheduledService()
      await awakeFor(new Date('2026-11-09T09:00:30-08:00').getTime() - Date.now())
      await vi.waitFor(() => expect(statuses()).toEqual(['dispatched']))
      service.stop()
    })
  }
)
