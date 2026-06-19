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
        reuseSession: true
      })
    )
    expect(runtime.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      expect.objectContaining({ enabled: false, reuseSession: false, rrule: '0 9 * * 1-5' })
    )
    expect(runtime.deleteAutomation).toHaveBeenCalledWith('auto-1')
    expect(runtime.runAutomationNow).toHaveBeenCalledWith('auto-1')
    expect(runtime.listAutomationRuns).toHaveBeenCalledWith('auto-1')
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

  it('routes automation folder operations and move-to-folder to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAutomationFolders: vi.fn().mockReturnValue([{ id: 'fld-1', name: 'Release' }]),
      createAutomationFolder: vi.fn().mockReturnValue({ id: 'fld-2', name: 'Nightly' }),
      updateAutomationFolder: vi.fn().mockReturnValue({ id: 'fld-1', name: 'Releases' }),
      deleteAutomationFolder: vi.fn().mockReturnValue({ id: 'fld-1', unfiledCount: 2 }),
      moveAutomationToFolder: vi
        .fn()
        .mockResolvedValue({ id: 'auto-1', name: 'Daily', folderId: 'fld-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await dispatcher.dispatch(makeRequest('automation.listFolders'))
    await dispatcher.dispatch(
      makeRequest('automation.createFolder', {
        name: 'Nightly',
        color: 'blue',
        parentFolderId: null
      })
    )
    await dispatcher.dispatch(
      makeRequest('automation.updateFolder', { id: 'fld-1', updates: { name: 'Releases' } })
    )
    await dispatcher.dispatch(makeRequest('automation.deleteFolder', { id: 'fld-1' }))
    await dispatcher.dispatch(
      makeRequest('automation.moveToFolder', { automationId: 'auto-1', folderId: 'fld-1' })
    )
    await dispatcher.dispatch(
      makeRequest('automation.moveToFolder', { automationId: 'auto-1', folderId: null })
    )

    expect(runtime.listAutomationFolders).toHaveBeenCalled()
    expect(runtime.createAutomationFolder).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Nightly', color: 'blue' })
    )
    expect(runtime.updateAutomationFolder).toHaveBeenCalledWith(
      'fld-1',
      expect.objectContaining({ name: 'Releases' })
    )
    expect(runtime.deleteAutomationFolder).toHaveBeenCalledWith('fld-1')
    expect(runtime.moveAutomationToFolder).toHaveBeenCalledWith('auto-1', 'fld-1')
    // null folderId (unfile) must survive validation rather than coercing to undefined.
    expect(runtime.moveAutomationToFolder).toHaveBeenCalledWith('auto-1', null)
  })

  it('passes folderId through automation create and update', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createAutomation: vi.fn().mockResolvedValue({ id: 'auto-2', folderId: 'fld-1' }),
      updateAutomation: vi.fn().mockResolvedValue({ id: 'auto-1', folderId: null })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    await dispatcher.dispatch(
      makeRequest('automation.create', {
        name: 'Filed',
        prompt: 'Run',
        agentId: 'codex',
        repo: 'repo-1',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1,
        folderId: 'fld-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('automation.update', { id: 'auto-1', updates: { folderId: null } })
    )

    expect(runtime.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: 'fld-1' })
    )
    expect(runtime.updateAutomation).toHaveBeenCalledWith('auto-1', { folderId: null })
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
