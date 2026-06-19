import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Repo } from '../../shared/types'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { AutomationService } from './service'

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

vi.mock('../git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
}))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
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

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('dispatches an enabled automation when its next run is due', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Morning check',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })

    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)

    service.start()
    service.setRendererReady()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    )
    service.stop()

    const [, payload] = send.mock.calls[0]
    expect(payload.automation.id).toBe(automation.id)
    expect(payload.run.scheduledFor).toBe(new Date('2026-05-13T09:00:00').getTime())
    expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatching')
    expect(store.listAutomations().find((entry) => entry.id === automation.id)?.nextRunAt).toBe(
      new Date('2026-05-14T09:00:00').getTime()
    )
  })

  it('returns the persisted status for manual runs after dispatch is requested', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Manual check',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)
    service.setRendererReady()

    const run = await service.runNow(automation.id)

    expect(run.status).toBe('dispatching')
    expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatching')
    expect(send).toHaveBeenCalledWith(
      'automations:dispatchRequested',
      expect.objectContaining({
        run: expect.objectContaining({ id: run.id, status: 'dispatching' })
      })
    )
  })

  it('skips dispatch when the selected project host setup is gone', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Manual check',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      runContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'local',
        projectHostSetupId: 'missing-setup',
        repoId: 'r1',
        path: '/repo'
      },
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)
    service.setRendererReady()

    const run = await service.runNow(automation.id)

    expect(run.status).toBe('skipped_unavailable')
    expect(run.error).toBe('Project is not set up on the selected automation host anymore.')
    expect(send).not.toHaveBeenCalled()
  })

  it('skips dispatch when the saved project host setup path is stale', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo({ path: '/repo/current' }))
    const setup = store.getProjectHostSetups()[0]!
    const automation = store.createAutomation({
      name: 'Manual check',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      runContext: {
        kind: 'workspace-run',
        projectId: setup.projectId,
        hostId: setup.hostId,
        projectHostSetupId: setup.id,
        repoId: setup.repoId,
        path: '/repo/old'
      },
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)
    service.setRendererReady()

    const run = await service.runNow(automation.id)

    expect(run.status).toBe('skipped_unavailable')
    expect(run.error).toBe('Project path for the selected automation host has changed.')
    expect(send).not.toHaveBeenCalled()
  })

  it('skips runtime-owned automations before desktop renderer dispatch', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    const runtimeHostId = toRuntimeExecutionHostId('gpu-server')
    store.addRepo(makeRepo({ executionHostId: runtimeHostId }))
    const setup = store.getProjectHostSetups()[0]!
    const automation = store.createAutomation({
      name: 'Remote check',
      prompt: 'Check the remote repo',
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
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)
    service.setRendererReady()

    const run = await service.runNow(automation.id)

    expect(run.status).toBe('skipped_unavailable')
    expect(run.error).toContain('Remote-server automation scheduling is not available')
    expect(send).not.toHaveBeenCalled()
  })

  it('dispatches remote-host scheduled automations when service runs in serve mode', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    const runtimeHostId = toRuntimeExecutionHostId('gpu-server')
    store.addRepo(makeRepo({ executionHostId: runtimeHostId }))
    const setup = store.getProjectHostSetups()[0]!
    const automation = store.createAutomation({
      name: 'Remote check',
      prompt: 'Check the remote repo',
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
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const send = vi.fn()
    const service = new AutomationService(store, {
      tickMs: 60_000,
      allowRemoteHostScheduling: true
    })
    service.setWebContents({
      isDestroyed: () => false,
      send
    } as never)
    service.setRendererReady()

    const run = await service.runNow(automation.id)

    expect(run.status).toBe('dispatching')
    expect(send).toHaveBeenCalledWith(
      'automations:dispatchRequested',
      expect.objectContaining({
        automation: expect.objectContaining({ schedulerOwner: 'remote_host_service' }),
        run: expect.objectContaining({ id: run.id, status: 'dispatching' })
      })
    )
  })

  it('dispatches remote-host automations headlessly when no renderer is available', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    const runtimeHostId = toRuntimeExecutionHostId('gpu-server')
    store.addRepo(makeRepo({ executionHostId: runtimeHostId }))
    const setup = store.getProjectHostSetups()[0]!
    const automation = store.createAutomation({
      name: 'Remote check',
      prompt: 'Check the remote repo',
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
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const service = new AutomationService(store, {
      tickMs: 60_000,
      allowRemoteHostScheduling: true,
      headlessDispatcher: vi.fn().mockResolvedValue({
        workspaceId: 'remote-wt-1',
        workspaceDisplayName: 'Remote automation',
        terminalSessionId: 'remote-tab-1',
        completion: Promise.resolve({
          status: 'completed',
          outputSnapshot: {
            format: 'plain_text',
            content: 'Done.',
            capturedAt: Date.now(),
            truncated: false
          },
          error: null
        })
      })
    })

    const run = await service.runNow(automation.id)

    expect(run.status).toBe('dispatched')
    expect(run.workspaceId).toBe('remote-wt-1')
    expect(run.workspaceDisplayName).toBe('Remote automation')
    expect(run.terminalSessionId).toBe('remote-tab-1')
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
        status: 'completed',
        workspaceId: 'remote-wt-1',
        terminalSessionId: 'remote-tab-1',
        outputSnapshot: expect.objectContaining({ content: 'Done.' })
      })
    )
  })

  it('attaches provider usage when a completed run can be attributed', async () => {
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
    const run = store.createAutomationRun(automation, Date.now(), 'manual')
    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      error: null
    })
    const usage = {
      status: 'known' as const,
      provider: 'claude' as const,
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
      reasoningOutputTokens: null,
      totalTokens: 185,
      estimatedCostUsd: 0.001,
      estimatedCostSource: 'api_equivalent' as const,
      providerSessionId: 'provider-session-1',
      attribution: 'provider_session_time_window' as const,
      collectedAt: Date.now(),
      unavailableReason: null,
      unavailableMessage: null
    }
    const getAutomationRunUsage = vi.fn().mockResolvedValue(usage)
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

    expect(updated.usage).toEqual(usage)
    expect(getAutomationRunUsage).toHaveBeenCalledWith({
      worktreeId: 'wt1',
      terminalSessionId: 'tab-1',
      startedAt: expect.any(Number),
      completedAt: expect.any(Number)
    })
  })

  it('does not recollect usage for an already-finalized run', async () => {
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
    const run = store.createAutomationRun(automation, Date.now(), 'manual')
    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      error: null
    })
    const usage = {
      status: 'known' as const,
      provider: 'claude' as const,
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
      reasoningOutputTokens: null,
      totalTokens: 185,
      estimatedCostUsd: 0.001,
      estimatedCostSource: 'api_equivalent' as const,
      providerSessionId: 'provider-session-1',
      attribution: 'provider_session_time_window' as const,
      collectedAt: Date.now(),
      unavailableReason: null,
      unavailableMessage: null
    }
    const getAutomationRunUsage = vi.fn().mockResolvedValue(usage)
    const service = new AutomationService(store, {
      tickMs: 60_000,
      claudeUsage: { getAutomationRunUsage } as never
    })
    const result = {
      runId: run.id,
      status: 'completed' as const,
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      error: null
    }

    const first = await service.markDispatchResult(result)
    const second = await service.markDispatchResult(result)

    expect(first.usage).toEqual(usage)
    expect(second.usage).toEqual(usage)
    expect(getAutomationRunUsage).toHaveBeenCalledTimes(1)
  })

  it('records unsupported usage cleanly for completed agents without local usage stores', async () => {
    vi.setSystemTime(new Date('2026-05-13T10:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Gemini check',
      prompt: 'Check spend',
      agentId: 'gemini',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, Date.now(), 'manual')
    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      error: null
    })
    const service = new AutomationService(store, { tickMs: 60_000 })

    const updated = await service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      workspaceId: 'wt1',
      terminalSessionId: 'tab-1',
      error: null
    })

    expect(updated.usage?.status).toBe('unavailable')
    expect(updated.usage?.unavailableReason).toBe('provider_unsupported')
  })
})
