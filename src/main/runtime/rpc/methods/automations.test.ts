import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations'
import { AUTOMATION_SHELL_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('automation RPC methods', () => {
  it('routes automation CRUD and run operations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomations: vi.fn().mockReturnValue([{ id: 'auto-1', name: 'Daily review' }]),
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

    expect(runtime.listAutomations).toHaveBeenCalled()
    expect(runtime.showAutomation).toHaveBeenCalledWith('auto-1')
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
      })
    )
    expect(runtime.deleteAutomation).toHaveBeenCalledWith('auto-1')
    expect(runtime.runAutomationNow).toHaveBeenCalledWith('auto-1')
    expect(runtime.listAutomationRuns).toHaveBeenCalledWith('auto-1')
  })

  it('preserves an explicit blank terminal when creating and updating an automation', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createAutomation: vi.fn().mockResolvedValue({ id: 'auto-1', agentId: null }),
      updateAutomation: vi.fn().mockResolvedValue({ id: 'auto-1', agentId: null })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    const created = await dispatcher.dispatch(
      makeRequest('automation.create', {
        name: 'Shell check',
        prompt: 'echo ready',
        agentId: null,
        repo: 'repo-1',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1
      })
    )
    const updated = await dispatcher.dispatch(
      makeRequest('automation.update', { id: 'auto-1', updates: { agentId: null } })
    )

    expect(created).toMatchObject({ ok: true })
    expect(updated).toMatchObject({ ok: true })
    expect(runtime.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: null })
    )
    expect(runtime.updateAutomation).toHaveBeenCalledWith('auto-1', { agentId: null })
  })

  it('does not publish nullable agent IDs to paired clients that predate shell automations', () => {
    const automations = [
      { id: 'agent', agentId: 'codex' },
      { id: 'shell', agentId: null }
    ]
    const runtime = {
      listAutomations: () => automations,
      showAutomation: () => automations[1]
    } as unknown as OrcaRuntimeService
    const context = { runtime, clientKind: 'runtime' as const, clientCapabilities: [] }
    const list = AUTOMATION_METHODS.find((method) => method.name === 'automation.list')!
    const show = AUTOMATION_METHODS.find((method) => method.name === 'automation.show')!

    expect(list.handler(undefined, context)).toEqual({ automations: [automations[0]] })
    expect(() => show.handler({ id: 'shell' }, context)).toThrow('newer Orca client')
    expect(
      list.handler(undefined, {
        ...context,
        clientCapabilities: [AUTOMATION_SHELL_RUNTIME_CAPABILITY]
      })
    ).toEqual({ automations })
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

    expect(runtime.updateAutomation).toHaveBeenCalledWith('auto-1', { baseBranch: null })
  })
})
