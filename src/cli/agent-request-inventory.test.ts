import { describe, expect, it } from 'vitest'
import { listAgentRequests } from './agent-request-inventory'
import {
  REQUEST_MARKER,
  REQUEST_PROMPT,
  REQUEST_RUNTIME,
  REQUEST_SESSION,
  REQUEST_WORKSPACE,
  requestFixtureClient
} from './agent-request-test-fixtures'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../shared/protocol-version'

const scope = { worktree: `id:${REQUEST_WORKSPACE}`, sessionId: REQUEST_SESSION }
const response = (result: unknown) => ({
  id: 'test',
  ok: true,
  _meta: { runtimeId: REQUEST_RUNTIME },
  result
})

describe('explicit native request inventory', () => {
  it('reads complete authoritative prompts without starting, subscribing or listing all sessions', async () => {
    const { client, call } = requestFixtureClient()
    const result = await listAgentRequests(client, { ...scope, turnItemId: 'provider:turn-1' })
    expect(result).toMatchObject({
      runtimeId: REQUEST_RUNTIME,
      workspaceId: REQUEST_WORKSPACE,
      fence: 7,
      marker: REQUEST_MARKER,
      requests: [REQUEST_PROMPT]
    })
    expect(
      call.mock.calls.every(([method]) =>
        [
          'status.get',
          'session.tabs.list',
          'agentSession.history',
          'agentSession.currentRequests'
        ].includes(method)
      )
    ).toBe(true)
    expect(
      call.mock.calls
        .filter(([method]) => method === 'session.tabs.list')
        .every(
          ([, params]) => JSON.stringify(params) === JSON.stringify({ worktree: scope.worktree })
        )
    ).toBe(true)
    expect(
      (await listAgentRequests(client, { ...scope, turnItemId: 'provider:another-turn' })).requests
    ).toEqual([])
  })

  it('reassembles UTF-16 chunks including exact question text, rather than filtering malformed rows', async () => {
    const prompt = {
      ...REQUEST_PROMPT,
      body: { ...REQUEST_PROMPT.body, title: '한글과 🙂 그대로' }
    }
    const json = JSON.stringify([prompt])
    const { client } = requestFixtureClient((method, params) => {
      if (
        method !== 'agentSession.currentRequests' ||
        typeof params !== 'object' ||
        params === null ||
        !('version' in params)
      ) {
        return
      }
      if (params.version !== REQUEST_MARKER.version) {
        return response({ marker: REQUEST_MARKER, json: '', nextCursor: 0, restart: true })
      }
      const cursor = 'cursor' in params && typeof params.cursor === 'number' ? params.cursor : 0
      const end = Math.min(cursor + 19, json.length)
      return response({
        marker: REQUEST_MARKER,
        json: json.slice(cursor, end),
        nextCursor: end === json.length ? null : end
      })
    })
    expect((await listAgentRequests(client, scope)).requests[0]?.body).toEqual(prompt.body)
  })

  it.each(['owner', 'epoch', 'publisher', 'revision', 'version'])(
    'never completes from mixed %s markers',
    async (field) => {
      const { client } = requestFixtureClient((method, params) => {
        if (
          method !== 'agentSession.currentRequests' ||
          typeof params !== 'object' ||
          params === null ||
          !('version' in params) ||
          params.version !== REQUEST_MARKER.version
        ) {
          return
        }
        const changed = {
          ...REQUEST_MARKER,
          [field]:
            field === 'revision'
              ? 2
              : field === 'publisher' || field === 'version'
                ? '44444444-4444-4444-8444-444444444444'
                : 'changed'
        }
        return response({
          marker: changed,
          json: JSON.stringify([REQUEST_PROMPT]),
          nextCursor: null
        })
      })
      await expect(listAgentRequests(client, scope)).rejects.toMatchObject({
        code: 'agent_request_unverifiable'
      })
    }
  )

  it.each(['bad-cursor', 'foreign-row', 'duplicate', 'shortened', 'too-many-pages'])(
    'refuses %s without claiming a partial inventory',
    async (mode) => {
      const { client } = requestFixtureClient((method, params) => {
        if (
          method !== 'agentSession.currentRequests' ||
          typeof params !== 'object' ||
          params === null ||
          !('version' in params) ||
          params.version !== REQUEST_MARKER.version
        ) {
          return
        }
        const cursor = 'cursor' in params && typeof params.cursor === 'number' ? params.cursor : 0
        const values =
          mode === 'foreign-row'
            ? [{ ...REQUEST_PROMPT, body: { kind: 'message' } }]
            : mode === 'duplicate'
              ? [REQUEST_PROMPT, REQUEST_PROMPT]
              : mode === 'shortened'
                ? [{ ...REQUEST_PROMPT, shortened: true }]
                : [REQUEST_PROMPT]
        return response({
          marker: REQUEST_MARKER,
          json: mode === 'too-many-pages' ? '[' : JSON.stringify(values),
          nextCursor: mode === 'bad-cursor' ? 1 : mode === 'too-many-pages' ? cursor + 1 : null
        })
      })
      await expect(listAgentRequests(client, scope)).rejects.toMatchObject({
        code: 'agent_request_unverifiable'
      })
    }
  )

  it('refuses a workspace that cannot prove the named session', async () => {
    const { client, call } = requestFixtureClient((method) =>
      method === 'session.tabs.list'
        ? response({ worktree: REQUEST_WORKSPACE, tabs: [] })
        : undefined
    )
    await expect(listAgentRequests(client, scope)).rejects.toMatchObject({
      code: 'agent_request_unverifiable'
    })
    expect(call.mock.calls.some(([method]) => method === 'agentSession.currentRequests')).toBe(
      false
    )
  })

  it('refuses a host without authoritative current-request support before reading transcripts', async () => {
    const { client, call } = requestFixtureClient((method) =>
      method === 'status.get'
        ? response({
            runtimeId: REQUEST_RUNTIME,
            capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
          })
        : undefined
    )
    await expect(listAgentRequests(client, scope)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  })
})
