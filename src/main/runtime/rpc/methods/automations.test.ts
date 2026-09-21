import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('automation RPC methods', () => {
  it('routes automation CRUD and run operations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomations: vi.fn().mockReturnValue([{ id: 'auto-1', name: 'Daily review' }]),
      listAutomationsForScope: vi.fn().mockReturnValue({
        automations: [{ id: 'auto-1', name: 'Daily review' }],
        items: [{ automationId: 'auto-1', selector: { kind: 'self' } }]
      }),
      showAutomation: vi.fn().mockReturnValue({ id: 'auto-1', name: 'Daily review' }),
      createAutomation: vi.fn().mockResolvedValue({ id: 'auto-2', name: 'New review' }),
      updateAutomation: vi.fn().mockResolvedValue({ id: 'auto-1', name: 'Paused' }),
      deleteAutomation: vi.fn().mockReturnValue({ removed: true, id: 'auto-1' }),
      runAutomationNow: vi.fn().mockResolvedValue({ id: 'run-1', automationId: 'auto-1' }),
      listAutomationRuns: vi.fn().mockReturnValue([{ id: 'run-1', automationId: 'auto-1' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await dispatcher.dispatch(makeRequest('automation.list'))
    await dispatcher.dispatch(makeRequest('automation.show', { id: 'auto-1' }))
    await dispatcher.dispatch(
      makeRequest('automation.create', {
        name: 'New review',
        prompt: 'Review changes',
        precheck: { command: 'test -f ready', timeoutSeconds: 30 },
        agentId: 'codex',
        runContext: {
          kind: 'workspace-run',
          projectId: 'github:stablyai/orca',
          hostId: 'runtime:gpu',
          projectHostSetupId: 'setup-gpu',
          repoId: 'repo-gpu',
          path: '/srv/orca'
        },
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:stablyai/orca',
          hostId: 'local',
          projectHostSetupId: 'setup-local',
          repoId: 'repo-local',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
        },
        repo: 'repo-1',
        setupDecision: 'skip',
        reuseSession: true,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1
      })
    )
    await dispatcher.dispatch(
      makeRequest('automation.update', {
        id: 'auto-1',
        updates: {
          enabled: false,
          setupDecision: 'run',
          reuseSession: false,
          rrule: '0 9 * * 1-5',
          dtstart: 2
        }
      })
    )
    await dispatcher.dispatch(makeRequest('automation.delete', { id: 'auto-1' }))
    await dispatcher.dispatch(makeRequest('automation.runNow', { id: 'auto-1' }))
    await dispatcher.dispatch(makeRequest('automation.runs', { automationId: 'auto-1' }))

    expect(runtime.listAutomationsForScope).toHaveBeenCalledWith({})
    // A legacy client sends no precondition, so each call forwards an absent expected owner.
    expect(runtime.showAutomation).toHaveBeenCalledWith('auto-1', undefined)
    expect(runtime.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New review',
        prompt: 'Review changes',
        precheck: { command: 'test -f ready', timeoutSeconds: 30 },
        agentId: 'codex',
        runContext: expect.objectContaining({ hostId: 'runtime:gpu' }),
        sourceContext: expect.objectContaining({ hostId: 'local' }),
        repo: 'repo-1',
        setupDecision: 'skip',
        reuseSession: true
      })
    )
    expect(runtime.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      expect.objectContaining({
        enabled: false,
        setupDecision: 'run',
        reuseSession: false,
        rrule: '0 9 * * 1-5'
      }),
      { expectedOwner: undefined, destination: undefined }
    )
    expect(runtime.deleteAutomation).toHaveBeenCalledWith('auto-1', undefined)
    expect(runtime.runAutomationNow).toHaveBeenCalledWith('auto-1', undefined)
    expect(runtime.listAutomationRuns).toHaveBeenCalledWith('auto-1', undefined)
  })

  it('returns a cursor page when the caller requests a bounded run history', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomationRunsPage: vi.fn().mockReturnValue({
        runs: [{ id: 'run-100', automationId: 'auto-1' }],
        nextCursor: '100'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await expect(
      dispatcher.dispatch(makeRequest('automation.runs', { automationId: 'auto-1', limit: 100 }))
    ).resolves.toMatchObject({
      ok: true,
      result: { nextCursor: '100' }
    })
    expect(runtime.listAutomationRunsPage).toHaveBeenCalledWith('auto-1', undefined, 100, undefined)
  })

  it('rejects unknown providers and invalid schedules', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createAutomation: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await expect(
      dispatcher.dispatch(
        makeRequest('automation.create', {
          name: 'Bad provider',
          prompt: 'Run',
          agentId: 'not-real',
          repo: 'repo-1',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          dtstart: 1
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })

    await expect(
      dispatcher.dispatch(
        makeRequest('automation.create', {
          name: 'Bad schedule',
          prompt: 'Run',
          agentId: 'codex',
          repo: 'repo-1',
          rrule: 'not a schedule',
          dtstart: 1
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('preserves null baseBranch update values through the RPC boundary', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateAutomation: vi.fn().mockResolvedValue({ id: 'auto-1', baseBranch: null })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await dispatcher.dispatch(
      makeRequest('automation.update', {
        id: 'auto-1',
        updates: { baseBranch: null }
      })
    )

    expect(runtime.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      { baseBranch: null },
      { expectedOwner: undefined, destination: undefined }
    )
  })
})
