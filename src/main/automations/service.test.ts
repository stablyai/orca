import {
  closeTestStores,
  createStore,
  testState,
  readPersistedStateJson,
  writePersistedStateJson
} from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'

import { AutomationService } from './service'
import { startedAutomationService, TICK_MS, tickAt } from './automation-service-tick.test-fixture'

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

/** Inject persisted drift that normal creation would resolve. */
function mutateDataFile(mutate: (state: { automations: Record<string, unknown>[] }) => void): void {
  const file = join(testState.dir, 'orca-data.json')
  const state = JSON.parse(readPersistedStateJson(file))
  mutate(state)
  writePersistedStateJson(file, JSON.stringify(state))
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

const LAUNCHED = { workspaceId: 'wt1', terminalSessionId: 'tab-1' }

const dailyAt9 = (name: string) => ({
  name,
  prompt: 'Check the repo',
  agentId: 'claude' as const,
  projectId: 'r1',
  workspaceMode: 'existing' as const,
  workspaceId: 'wt1',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: new Date('2026-05-12T00:00:00').getTime()
})

describe('AutomationService', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps completed history when the usage backend disconnects', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Check',
      prompt: 'Check spend',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.now()
    })
    const run = store.createAutomationRun(automation, Date.now(), 'manual')
    const service = new AutomationService(store, {
      claudeUsage: {
        getAutomationRunUsage: async () => {
          throw new Error('Backend disconnected')
        }
      }
    })
    try {
      const updated = await service.markDispatchResult({
        runId: run.id,
        status: 'completed',
        workspaceId: 'wt1',
        terminalSessionId: 'tab-1',
        error: null
      })
      expect(updated).toMatchObject({
        status: 'completed',
        usage: { status: 'unavailable', provider: 'claude', unavailableReason: 'scan_failed' }
      })
      expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
        status: 'completed',
        usage: { status: 'unavailable' }
      })
    } finally {
      service.stop()
    }
  })

  it('does not throw when retention evicts the run during usage collection', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Costed check',
      prompt: 'Check spend',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00').getTime()
    })
    const base = Date.now()
    const run = store.createAutomationRun(automation, base, 'manual')
    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      error: null
    })
    // New runs can prune this finalized run while usage collection waits.
    const getAutomationRunUsage = vi.fn().mockImplementation(async () => {
      for (let i = 1; i <= 120; i++) {
        const later = store.createAutomationRun(automation, base + i * 60_000)
        store.updateAutomationRun({
          runId: later.id,
          status: 'completed',
          workspaceId: 'wt1',
          error: null
        })
      }
      return null
    })
    const service = new AutomationService(store, {
      tickMs: 60_000,
      claudeUsage: { getAutomationRunUsage } as never
    })

    const updated = await service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      error: null
    })

    expect(updated.id).toBe(run.id)
    expect(store.listAutomationRuns(automation.id).some((entry) => entry.id === run.id)).toBe(false)
  })

  // Name sorting evaluates the poison record before the healthy one.
  it('keeps evaluating later due automations after an unreadable schedule throws', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const poison = store.createAutomation({
      name: 'A poison schedule',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })
    const healthy = store.createAutomation({
      name: 'B healthy schedule',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })
    mutateDataFile((state) => {
      const entry = state.automations.find((automation) => automation.id === poison.id)!
      entry.rrule = 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0'
    })
    const reloaded = await createStore()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    const launch = vi.fn(async (_request: { automation: { id: string } }) => LAUNCHED)
    const service = startedAutomationService(reloaded, launch)
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    service.stop()

    expect(launch.mock.calls[0]?.[0].automation.id).toBe(healthy.id)
    expect(reloaded.listAutomationRuns(healthy.id)[0]?.status).toBe('dispatched')
    const poisonRun = reloaded.listAutomationRuns(poison.id)[0]
    expect(poisonRun?.status).toBe('skipped_unavailable')
    expect(poisonRun?.error).toBe(
      'Orca could not evaluate this automation and skipped the occurrence.'
    )
    expect(logged).toHaveBeenCalled()
  })

  it('starts every due automation without waiting for an earlier launch', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const slow = store.createAutomation(dailyAt9('A slow'))
    const fast = store.createAutomation(dailyAt9('B fast'))
    const launch = vi.fn(({ automation }: { automation: { id: string } }) =>
      automation.id === slow.id ? new Promise<typeof LAUNCHED>(() => {}) : Promise.resolve(LAUNCHED)
    )
    const service = startedAutomationService(store, launch)

    await tickAt('2026-05-13T09:01:00')
    await vi.waitFor(() => expect(store.listAutomationRuns(fast.id)[0]?.status).toBe('dispatched'))
    expect(store.listAutomationRuns(slow.id)[0]?.status).toBe('dispatching')
    service.stop()
  })

  it('fails a retained pending run at startup before catch-up could launch it', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation(dailyAt9('Quit between writes'))
    // Orca quit after saving the run and before advancing the schedule.
    const retained = store.createAutomationRun(automation, automation.nextRunAt)
    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    const launch = vi.fn(async () => LAUNCHED)
    const service = new AutomationService(store, {
      tickMs: TICK_MS,
      terminalLauncher: { launch, available: () => true },
      terminalObserver: {
        resolveRunTerminal: () => null,
        observeCompletion: () => new Promise(() => {})
      }
    })

    service.start()
    await vi.waitFor(() =>
      expect(store.listAutomations()[0]?.nextRunAt).toBe(new Date('2026-05-14T09:00:00').getTime())
    )
    await service.runInAutomationLane(automation.id, async () => undefined)

    expect(store.listAutomationRuns(automation.id)).toEqual([
      expect.objectContaining({
        id: retained.id,
        status: 'dispatch_failed',
        error: 'Orca stopped before this run could launch.'
      })
    ])
    expect(launch).not.toHaveBeenCalled()
    service.stop()
  })
})
