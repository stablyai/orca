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
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { AutomationService } from './service'

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

  it('dispatches due scheduled automations headlessly', async () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const beforeRunAt = new Date(2026, 4, 13, 8, 59).getTime()
    const scheduledRunAt = new Date(2026, 4, 13, 9, 0).getTime()
    const afterRunAt = new Date(2026, 4, 13, 9, 1).getTime()
    const nextRunAt = new Date(2026, 4, 14, 9, 0).getTime()

    vi.setSystemTime(beforeRunAt)
    const store = await createStore()
    const runtimeHostId = toRuntimeExecutionHostId('gpu-server')
    const repo = makeRepo({ executionHostId: runtimeHostId })
    store.addRepo(repo)
    const setup = store.getProjectHostSetups()[0]!
    const automation = store.createAutomation(
      {
        name: 'Morning check',
        prompt: 'Check the repo',
        agentId: 'claude',
        projectId: 'r1',
        runContext: {
          kind: 'workspace-run',
          projectId: setup.projectId,
          hostId: runtimeHostId,
          projectHostSetupId: setup.id,
          repoId: setup.repoId,
          path: setup.path
        },
        workspaceMode: 'new_per_run',
        timezone,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: new Date(2026, 4, 12, 0, 0).getTime()
      },
      { resolvedRepo: repo }
    )

    const headlessDispatcher = vi.fn().mockResolvedValue({
      workspaceId: 'wt1',
      workspaceDisplayName: 'Morning check',
      terminalSessionId: 'tab-1',
      terminalPaneKey: 'pane-1',
      terminalPtyId: 'pty-1'
    })
    const service = new AutomationService(store, {
      tickMs: 60_000,
      allowRemoteHostScheduling: true,
      headlessDispatcher
    })

    try {
      vi.setSystemTime(afterRunAt)
      service.start()
      await vi.waitFor(() => expect(headlessDispatcher).toHaveBeenCalledTimes(1))
      const run = store.listAutomationRuns(automation.id)[0]
      expect(run?.status).toBe('dispatched')
      expect(run?.scheduledFor).toBe(scheduledRunAt)
      expect(headlessDispatcher).toHaveBeenCalledWith(
        expect.objectContaining({ automation: expect.objectContaining({ id: automation.id }) })
      )
      await vi.waitFor(() =>
        expect(store.listAutomations().find((entry) => entry.id === automation.id)?.nextRunAt).toBe(
          nextRunAt
        )
      )
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
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
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
    const send = vi.fn()
    const service = new AutomationService(reloaded, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send })

    service.start()
    service.setRendererReady()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    )
    service.stop()

    const [, payload] = send.mock.calls[0]
    expect(payload.automation.id).toBe(healthy.id)
    expect(reloaded.listAutomationRuns(healthy.id)[0]?.status).toBe('dispatching')
    const poisonRun = reloaded.listAutomationRuns(poison.id)[0]
    expect(poisonRun?.status).toBe('skipped_unavailable')
    expect(poisonRun?.error).toBe(
      'Orca could not evaluate this automation and skipped the occurrence.'
    )
    expect(logged).toHaveBeenCalled()
  })

  it('keeps evaluating later due automations after an unreadable cron schedule throws', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const poison = store.createAutomation({
      name: 'A poison cron',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: '0 9 * * *',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })
    const healthy = store.createAutomation({
      name: 'B healthy cron',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: '0 9 * * *',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })
    mutateDataFile((state) => {
      const entry = state.automations.find((automation) => automation.id === poison.id)!
      entry.rrule = '0 9 32 * *'
    })
    const reloaded = await createStore()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    const send = vi.fn()
    const service = new AutomationService(reloaded, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send })

    service.start()
    service.setRendererReady()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    )
    service.stop()

    const [, payload] = send.mock.calls[0]
    expect(payload.automation.id).toBe(healthy.id)
    expect(reloaded.listAutomationRuns(healthy.id)[0]?.status).toBe('dispatching')
    expect(reloaded.listAutomationRuns(poison.id)[0]?.error).toBe(
      'Orca could not evaluate this automation and skipped the occurrence.'
    )
    expect(logged).toHaveBeenCalled()
  })

  it('marks the run dispatch_failed when the renderer send throws', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Renderer gone',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: '0 9 * * *',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    logged.mockClear()

    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    const send = vi.fn(() => {
      throw new Error('renderer is gone')
    })
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send })

    service.start()
    service.setRendererReady()
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    service.stop()

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('dispatch_failed')
    expect(runs[0]?.error).toBe('renderer is gone')
    expect(logged).not.toHaveBeenCalled()
  })
})
