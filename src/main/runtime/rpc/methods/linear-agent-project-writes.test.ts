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
    linearProjectUpdateAddForAgents: vi.fn().mockResolvedValue({ ok: true }),
    linearProjectCreateForAgents: vi.fn().mockResolvedValue({ ok: true })
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

  it('registers project create in the default RPC method set', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime })

    const response = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { name: 'Aurora', teams: ['ENG'] })
    )

    expect(errorCode(response)).not.toBe('method_not_found')
    expect(response.ok).toBe(true)
  })
})

describe('linear.agentProjectCreate params', () => {
  it('trims the name, keeps prose untrimmed, and forwards references as user input', async () => {
    const runtime = makeRuntime()
    const response = await makeDispatcher(runtime).dispatch(
      makeRequest('linear.agentProjectCreate', {
        name: '  Aurora Launch  ',
        teams: ['ENG', 'Design Team'],
        description: '  short summary  ',
        content: '  # Overview  ',
        status: 'In Progress',
        lead: 'me',
        members: ['ada@example.com'],
        labels: ['Launch'],
        priority: 0,
        startDate: '2026-01-05',
        targetDate: '2026-02-28',
        color: '#5E6AD2',
        icon: 'Rocket',
        writeId: WRITE_ID,
        workspaceId: 'workspace-1'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.linearProjectCreateForAgents).toHaveBeenCalledWith({
      name: 'Aurora Launch',
      teams: ['ENG', 'Design Team'],
      description: '  short summary  ',
      content: '  # Overview  ',
      status: 'In Progress',
      lead: 'me',
      members: ['ada@example.com'],
      labels: ['Launch'],
      priority: 0,
      startDate: '2026-01-05',
      targetDate: '2026-02-28',
      color: '#5E6AD2',
      icon: 'Rocket',
      writeId: WRITE_ID,
      workspaceId: 'workspace-1'
    })
  })

  it('normalizes CRLF and lone CR in description and content', async () => {
    const runtime = makeRuntime()
    const response = await makeDispatcher(runtime).dispatch(
      makeRequest('linear.agentProjectCreate', {
        name: 'Aurora',
        teams: ['ENG'],
        description: 'one\r\ntwo',
        content: 'alpha\rbeta\r\ngamma'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.linearProjectCreateForAgents).toHaveBeenCalledWith({
      name: 'Aurora',
      teams: ['ENG'],
      description: 'one\ntwo',
      content: 'alpha\nbeta\ngamma'
    })
  })

  it('keeps an empty description, because empty prose is a meaningful create value', async () => {
    const runtime = makeRuntime()
    const response = await makeDispatcher(runtime).dispatch(
      makeRequest('linear.agentProjectCreate', { name: 'Aurora', teams: ['ENG'], description: '' })
    )

    expect(response.ok).toBe(true)
    expect(runtime.linearProjectCreateForAgents).toHaveBeenCalledWith({
      name: 'Aurora',
      teams: ['ENG'],
      description: ''
    })
  })

  it('rejects a blank name, a missing name, and a missing or empty team set', async () => {
    const runtime = makeRuntime()
    const dispatcher = makeDispatcher(runtime)

    const blankName = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { name: '   ', teams: ['ENG'] })
    )
    const missingName = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { teams: ['ENG'] })
    )
    const missingTeams = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { name: 'Aurora' })
    )
    const emptyTeams = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { name: 'Aurora', teams: [] })
    )
    const blankTeam = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { name: 'Aurora', teams: ['  '] })
    )

    expect(errorMessage(blankName)).toContain('Missing project name')
    expect(missingName.ok).toBe(false)
    expect(missingTeams.ok).toBe(false)
    expect(errorMessage(emptyTeams)).toContain('At least one team is required')
    expect(blankTeam.ok).toBe(false)
    expect(runtime.linearProjectCreateForAgents).not.toHaveBeenCalled()
  })

  it('accepts references only as strings, never pre-resolved on the wire', async () => {
    const runtime = makeRuntime()
    const dispatcher = makeDispatcher(runtime)

    const resolvedTeams = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', {
        name: 'Aurora',
        teams: [{ id: 'team-uuid' }]
      })
    )
    const resolvedLead = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', {
        name: 'Aurora',
        teams: ['ENG'],
        lead: { id: 'user-uuid' }
      })
    )

    expect(resolvedTeams.ok).toBe(false)
    // Why: OptionalString drops a non-string lead rather than forwarding a resolved id.
    expect(resolvedLead.ok).toBe(true)
    expect(runtime.linearProjectCreateForAgents).toHaveBeenCalledWith({
      name: 'Aurora',
      teams: ['ENG']
    })
  })

  it('requires a UUID v4 write id and rejects other UUID versions', async () => {
    const runtime = makeRuntime()
    const dispatcher = makeDispatcher(runtime)

    const v1Response = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', {
        name: 'Aurora',
        teams: ['ENG'],
        writeId: '3f2b1a80-5f3a-11ee-8c99-0242ac120002'
      })
    )
    const garbageResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', {
        name: 'Aurora',
        teams: ['ENG'],
        writeId: 'not-a-uuid'
      })
    )
    const v4Response = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', {
        name: 'Aurora',
        teams: ['ENG'],
        writeId: WRITE_ID
      })
    )

    expect(errorCode(v1Response)).toBe('linear_invalid_write_id')
    expect(errorCode(garbageResponse)).toBe('linear_invalid_write_id')
    expect(v4Response.ok).toBe(true)
    expect(runtime.linearProjectCreateForAgents).toHaveBeenCalledTimes(1)
  })

  it('bounds priority to 0-4, rejects bad dates and colors, and rejects workspace all', async () => {
    const runtime = makeRuntime()
    const dispatcher = makeDispatcher(runtime)
    const base = { name: 'Aurora', teams: ['ENG'] }

    const highPriority = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { ...base, priority: 5 })
    )
    const fractionalPriority = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { ...base, priority: 1.5 })
    )
    const impossibleDate = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { ...base, startDate: '2026-02-31' })
    )
    const badColor = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { ...base, color: '5E6AD2' })
    )
    const workspaceAll = await dispatcher.dispatch(
      makeRequest('linear.agentProjectCreate', { ...base, workspaceId: 'all' })
    )

    expect(highPriority.ok).toBe(false)
    expect(fractionalPriority.ok).toBe(false)
    expect(impossibleDate.ok).toBe(false)
    expect(badColor.ok).toBe(false)
    expect(errorMessage(workspaceAll)).toContain(
      '--workspace all is only valid for project list, statuses, and labels'
    )
    expect(runtime.linearProjectCreateForAgents).not.toHaveBeenCalled()
  })
})
