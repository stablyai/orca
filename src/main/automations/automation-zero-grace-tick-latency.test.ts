import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import { AutomationService } from './service'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

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

async function createStore() {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

describe('AutomationService zero-grace tick latency', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const DUE = new Date('2026-05-13T09:00:00').getTime()

  const makeZeroGrace = (store: Awaited<ReturnType<typeof createStore>>) =>
    store.createAutomation({
      name: 'Zero grace',
      prompt: 'Run it',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      // Why a separator: without one resolveAutomationRunTarget refuses and the run records
      // skipped_unavailable, which would make a "not skipped_missed" assertion pass vacuously.
      workspaceId: 'r1::wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime(),
      missedRunGraceMinutes: 0
    })

  /** One evaluation pass at exactly `at` -- start()/setRendererReady() triggers it directly, so
   *  advancing the timer would silently add a second pass a minute later (and did). */
  const evaluateAt = async (
    store: Awaited<ReturnType<typeof createStore>>,
    at: number
  ): Promise<void> => {
    vi.setSystemTime(at)
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send: vi.fn() })
    service.start()
    service.setRendererReady()
    await vi.waitFor(() => {
      if (store.listAutomations().some((automation) => automation.nextRunAt <= at)) {
        throw new Error('Automation evaluation is still saving its next occurrence')
      }
    })
    service.stop()
  }

  const statusAt = async (lateMs: number): Promise<string | undefined> => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = makeZeroGrace(store)
    await evaluateAt(store, DUE + lateMs)
    return store.listAutomationRuns(automation.id)[0]?.status
  }

  // Why 1ms and 45s: the tick interval is never aligned to an occurrence, so ANY positive
  // lateness used to exceed a zero grace budget and skip the run (#11299).
  it.each([
    ['1ms late', 1],
    ['45s late', 45_000]
  ])('dispatches a zero-grace occurrence only the tick was late for (%s)', async (_l, lateMs) => {
    // Assert the outcome, not merely "not skipped_missed" -- a refused target would also
    // satisfy that while never dispatching.
    expect(await statusAt(lateMs)).toBe('dispatching')
  })

  // The other half of the invariant: real downtime still consumes the grace budget. A suspended
  // process keeps its start time, so this is the case a liveness flag would have waved through.
  it('still skips a zero-grace occurrence that came due during a long sleep', async () => {
    expect(await statusAt(4 * 60 * 60 * 1000)).toBe('skipped_missed')
  })

  // Just past the tolerance: the boundary has to bite, or the tolerance is a blanket grace.
  it('skips once lateness exceeds the tick-latency tolerance', async () => {
    expect(await statusAt(2 * 60_000 + 1)).toBe('skipped_missed')
  })

  // A restart that crosses the occurrence must behave like any other late tick, not like
  // downtime -- the elapsed lateness is what decides, so bookkeeping cannot drift.
  it('dispatches after a restart that crosses the occurrence within tolerance', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = makeZeroGrace(store)
    await evaluateAt(store, DUE - 30_000)
    // Nothing may have run yet, or the second pass is not the one under test.
    expect(store.listAutomationRuns(automation.id)).toHaveLength(0)
    await evaluateAt(store, DUE + 30_000)
    expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatching')
  })
})
