import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { LINEAR_AGENT_PROJECT_READ_METHODS } from './linear-agent-project-read'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    linearProjectShowForAgents: vi.fn().mockResolvedValue({ ok: true }),
    linearProjectStatusesForAgents: vi.fn().mockResolvedValue({ ok: true }),
    linearProjectLabelsForAgents: vi.fn().mockResolvedValue({ ok: true })
  } as unknown as OrcaRuntimeService
}

function errorMessage(response: Awaited<ReturnType<RpcDispatcher['dispatch']>>): string {
  return response.ok === false ? response.error.message : ''
}

describe('Linear agent project read RPC methods', () => {
  it('routes project reads to the runtime with trimmed targets', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_PROJECT_READ_METHODS })

    const showResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectShow', {
        input: '  Launch  ',
        workspaceId: 'workspace-1',
        updates: true,
        updatesLimit: 3
      })
    )
    const statusesResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectStatuses', { query: 'in progress', limit: 5 })
    )
    const labelsResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectLabels', { query: 'infra', workspaceId: 'all' })
    )

    expect(showResponse.ok).toBe(true)
    expect(statusesResponse.ok).toBe(true)
    expect(labelsResponse.ok).toBe(true)
    expect(runtime.linearProjectShowForAgents).toHaveBeenCalledWith({
      input: 'Launch',
      workspaceId: 'workspace-1',
      updates: true,
      updatesLimit: 3
    })
    expect(runtime.linearProjectStatusesForAgents).toHaveBeenCalledWith({
      query: 'in progress',
      limit: 5
    })
    expect(runtime.linearProjectLabelsForAgents).toHaveBeenCalledWith({
      query: 'infra',
      workspaceId: 'all'
    })
  })

  it('caps project metadata limits at the shared maximum', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_PROJECT_READ_METHODS })

    await dispatcher.dispatch(makeRequest('linear.agentProjectStatuses', { limit: 500 }))
    await dispatcher.dispatch(makeRequest('linear.agentProjectLabels', { limit: 500 }))

    expect(runtime.linearProjectStatusesForAgents).toHaveBeenCalledWith({ limit: 50 })
    expect(runtime.linearProjectLabelsForAgents).toHaveBeenCalledWith({ limit: 50 })
  })

  it('caps the project update limit at the shared maximum', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_PROJECT_READ_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('linear.agentProjectShow', { input: 'Launch', updates: true, updatesLimit: 400 })
    )

    expect(response.ok).toBe(true)
    expect(runtime.linearProjectShowForAgents).toHaveBeenCalledWith({
      input: 'Launch',
      updates: true,
      updatesLimit: 25
    })
  })

  it('rejects an update limit without the updates flag', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_PROJECT_READ_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('linear.agentProjectShow', { input: 'Launch', updatesLimit: 5 })
    )

    expect(response.ok).toBe(false)
    expect(errorMessage(response)).toContain('--updates-limit requires --updates')
    expect(runtime.linearProjectShowForAgents).not.toHaveBeenCalled()
  })

  it('rejects update limits that are not positive integers', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_PROJECT_READ_METHODS })

    const zeroResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectShow', { input: 'Launch', updates: true, updatesLimit: 0 })
    )
    const negativeResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectShow', { input: 'Launch', updates: true, updatesLimit: -2 })
    )
    const fractionalResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectShow', { input: 'Launch', updates: true, updatesLimit: 2.5 })
    )

    expect(zeroResponse.ok).toBe(false)
    expect(errorMessage(zeroResponse)).toContain('--updates-limit must be a positive integer')
    expect(negativeResponse.ok).toBe(false)
    expect(fractionalResponse.ok).toBe(false)
    expect(runtime.linearProjectShowForAgents).not.toHaveBeenCalled()
  })

  it('rejects an empty project target and workspace all for project show', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_PROJECT_READ_METHODS })

    const blankResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectShow', { input: '   ' })
    )
    const workspaceResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectShow', { input: 'Launch', workspaceId: 'all' })
    )

    expect(blankResponse.ok).toBe(false)
    expect(errorMessage(blankResponse)).toContain('Missing project')
    expect(workspaceResponse.ok).toBe(false)
    expect(errorMessage(workspaceResponse)).toContain(
      '--workspace all is only valid for project list, statuses, and labels'
    )
    expect(runtime.linearProjectShowForAgents).not.toHaveBeenCalled()
  })

  it('registers the project read methods in the default RPC method set', async () => {
    // Why: nothing else fails when a new method array is never spread into ALL_RPC_METHODS.
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime })

    const responses = await Promise.all([
      dispatcher.dispatch(makeRequest('linear.agentProjectShow', { input: 'Launch' })),
      dispatcher.dispatch(makeRequest('linear.agentProjectStatuses', {})),
      dispatcher.dispatch(makeRequest('linear.agentProjectLabels', {}))
    ])

    for (const response of responses) {
      expect(response.ok === false ? response.error.code : 'ok').not.toBe('method_not_found')
      expect(response.ok).toBe(true)
    }
  })
})
