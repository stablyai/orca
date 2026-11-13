import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import { startedAutomationService } from './testing/automation-service-tick.test-fixture'

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
      workspaceId: 'r1::wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime(),
      missedRunGraceMinutes: 0
    })

  /** Set the clock without advancing timers to avoid a second scheduler pass. */
  const evaluateAt = async (
    store: Awaited<ReturnType<typeof createStore>>,
    at: number
  ): Promise<void> => {
    vi.setSystemTime(at)
    const service = startedAutomationService(store)
    await vi.waitFor(() => {
      if (
        store.listAutomations().some((automation) => automation.nextRunAt <= at) ||
        store.listAutomationRuns().some((run) => run.status === 'pending')
      ) {
        throw new Error('Automation evaluation is still saving its next occurrence')
      }
    })
    await service.runInAutomationLane(store.listAutomations()[0]!.id, async () => undefined)
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

  it.each([
    ['1ms late', 1],
    ['45s late', 45_000]
  ])('dispatches a zero-grace occurrence only the tick was late for (%s)', async (_l, lateMs) => {
    expect(await statusAt(lateMs)).toBe('dispatched')
  })

  it('skips once lateness exceeds the tick-latency tolerance', async () => {
    expect(await statusAt(2 * 60_000 + 1)).toBe('skipped_missed')
  })
})
