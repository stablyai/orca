import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { LINEAR_AGENT_PROJECT_WRITE_METHODS } from './linear-agent-project-writes'

const WRITE_ID = 'b7c8d9e0-1f2a-4b3c-8d4e-5f6a7b8c9d0e'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    linearProjectUpdateAddForAgents: vi.fn().mockResolvedValue({ ok: true })
  } as unknown as OrcaRuntimeService
}

function makeDispatcher(runtime: OrcaRuntimeService): RpcDispatcher {
  return new RpcDispatcher({ runtime, methods: LINEAR_AGENT_PROJECT_WRITE_METHODS })
}

function errorMessage(response: Awaited<ReturnType<RpcDispatcher['dispatch']>>): string {
  return response.ok === false ? response.error.message : ''
}

function errorCode(response: Awaited<ReturnType<RpcDispatcher['dispatch']>>): string {
  return response.ok === false ? response.error.code : 'ok'
}

describe('Linear agent project write RPC methods', () => {
  it('routes an update post to the runtime with a trimmed target and untrimmed body', async () => {
    const runtime = makeRuntime()
    const response = await makeDispatcher(runtime).dispatch(
      makeRequest('linear.agentProjectUpdateAdd', {
        input: '  Launch  ',
        workspaceId: 'workspace-1',
        body: '  Week 3 status.  ',
        health: 'atRisk',
        isDiffHidden: true,
        writeId: WRITE_ID
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.linearProjectUpdateAddForAgents).toHaveBeenCalledWith({
      input: 'Launch',
      workspaceId: 'workspace-1',
      body: '  Week 3 status.  ',
      health: 'atRisk',
      isDiffHidden: true,
      writeId: WRITE_ID
    })
  })

  it('normalizes CRLF and lone CR in the body to LF', async () => {
    const runtime = makeRuntime()
    const response = await makeDispatcher(runtime).dispatch(
      makeRequest('linear.agentProjectUpdateAdd', {
        input: 'Launch',
        body: 'line one\r\nline two\rline three'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.linearProjectUpdateAddForAgents).toHaveBeenCalledWith({
      input: 'Launch',
      body: 'line one\nline two\nline three'
    })
  })

  it('rejects an empty or line-ending-only body without calling the runtime', async () => {
    const runtime = makeRuntime()
    const dispatcher = makeDispatcher(runtime)

    const emptyResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', { input: 'Launch', body: '' })
    )
    const missingResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', { input: 'Launch' })
    )

    expect(emptyResponse.ok).toBe(false)
    expect(errorMessage(emptyResponse)).toContain('Missing update body')
    expect(missingResponse.ok).toBe(false)
    expect(runtime.linearProjectUpdateAddForAgents).not.toHaveBeenCalled()
  })

  it('keeps a whitespace-only body, because prose is never trimmed', async () => {
    const runtime = makeRuntime()
    const response = await makeDispatcher(runtime).dispatch(
      makeRequest('linear.agentProjectUpdateAdd', { input: 'Launch', body: '   ' })
    )

    expect(response.ok).toBe(true)
    expect(runtime.linearProjectUpdateAddForAgents).toHaveBeenCalledWith({
      input: 'Launch',
      body: '   '
    })
  })

  it('accepts only the API health spellings', async () => {
    const runtime = makeRuntime()
    const dispatcher = makeDispatcher(runtime)

    const apiResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', {
        input: 'Launch',
        body: 'status',
        health: 'offTrack'
      })
    )
    const cliResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', {
        input: 'Launch',
        body: 'status',
        health: 'off-track'
      })
    )
    const unknownResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', {
        input: 'Launch',
        body: 'status',
        health: 'blocked'
      })
    )

    expect(apiResponse.ok).toBe(true)
    expect(cliResponse.ok).toBe(false)
    expect(unknownResponse.ok).toBe(false)
    expect(runtime.linearProjectUpdateAddForAgents).toHaveBeenCalledTimes(1)
  })

  it('rejects a blank target and workspace all before reaching the runtime', async () => {
    const runtime = makeRuntime()
    const dispatcher = makeDispatcher(runtime)

    const blankResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', { input: '   ', body: 'status' })
    )
    const workspaceResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', {
        input: 'Launch',
        body: 'status',
        workspaceId: 'all'
      })
    )

    expect(blankResponse.ok).toBe(false)
    expect(errorMessage(blankResponse)).toContain('Missing project')
    expect(workspaceResponse.ok).toBe(false)
    expect(errorMessage(workspaceResponse)).toContain(
      '--workspace all is only valid for project list, statuses, and labels'
    )
    expect(runtime.linearProjectUpdateAddForAgents).not.toHaveBeenCalled()
  })

  it('rejects a write id that is not a UUID and accepts a non-v4 UUID', async () => {
    const runtime = makeRuntime()
    const dispatcher = makeDispatcher(runtime)

    const invalidResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', {
        input: 'Launch',
        body: 'status',
        writeId: 'not-a-uuid'
      })
    )
    // Why: project update posts use the generic UUID contract; v4 is project create's rule only.
    const v1WriteId = '3f2b1a80-5f3a-11ee-8c99-0242ac120002'
    const v1Response = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', {
        input: 'Launch',
        body: 'status',
        writeId: v1WriteId
      })
    )

    expect(invalidResponse.ok).toBe(false)
    expect(errorCode(invalidResponse)).toBe('linear_invalid_write_id')
    expect(v1Response.ok).toBe(true)
    expect(runtime.linearProjectUpdateAddForAgents).toHaveBeenCalledWith({
      input: 'Launch',
      body: 'status',
      writeId: v1WriteId
    })
  })

  it('registers the project write methods in the default RPC method set', async () => {
    // Why: nothing else fails when a new method array is never spread into ALL_RPC_METHODS.
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime })

    const response = await dispatcher.dispatch(
      makeRequest('linear.agentProjectUpdateAdd', { input: 'Launch', body: 'status' })
    )

    expect(errorCode(response)).not.toBe('method_not_found')
    expect(response.ok).toBe(true)
  })
})
