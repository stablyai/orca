import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import {
  MOBILE_AI_VAULT_SESSION_LIMIT,
  scanMobileAgentSessions,
  type AgentHistoryCachedSnapshot
} from './agent-history-session-scanner'

type Call = { method: string; params: unknown }

function fakeClient(handler: (call: Call) => RpcResponse) {
  const calls: Call[] = []
  const client = stubRpcClient({
    sendRequest: async (method: string, params?: unknown) => {
      const call = { method, params }
      calls.push(call)
      return handler(call)
    }
  })
  return { client, calls }
}

describe('scanMobileAgentSessions', () => {
  it('requests sessions with limit 500 without afterFingerprint when no previous snapshot exists', async () => {
    const { client, calls } = fakeClient(() => ({
      id: '1',
      ok: true,
      result: {
        sessions: [{ id: 's1' }],
        issues: [],
        fingerprint: 'fp-1'
      },
      _meta: { runtimeId: 'r1' }
    }))

    const result = await scanMobileAgentSessions(client, {
      scopePaths: ['/repo'],
      force: false
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      method: 'aiVault.listSessions',
      params: {
        limit: MOBILE_AI_VAULT_SESSION_LIMIT,
        force: false,
        scopePaths: ['/repo']
      }
    })
    expect(result.sessions).toEqual([{ id: 's1' }])
    expect(result.fingerprint).toBe('fp-1')
  })

  it('passes afterFingerprint and reuses previous sessions when host returns unchanged', async () => {
    const previous: AgentHistoryCachedSnapshot = {
      fingerprint: 'fp-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions
      sessions: [{ id: 's1', title: 'Cached session' }] as unknown as AiVaultSession[],
      issues: []
    }

    const { client, calls } = fakeClient(() => ({
      id: '1',
      ok: true,
      result: {
        sessions: [],
        issues: [],
        fingerprint: 'fp-1',
        unchanged: true
      },
      _meta: { runtimeId: 'r1' }
    }))

    const result = await scanMobileAgentSessions(client, {
      scopePaths: ['/repo'],
      force: false,
      previous
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.params).toMatchObject({
      afterFingerprint: 'fp-1'
    })
    expect(result.sessions).toBe(previous.sessions)
    expect(result.fingerprint).toBe('fp-1')
  })

  it('omits afterFingerprint when force is true', async () => {
    const previous: AgentHistoryCachedSnapshot = {
      fingerprint: 'fp-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions
      sessions: [{ id: 's1' }] as unknown as AiVaultSession[],
      issues: []
    }

    const { client, calls } = fakeClient(() => ({
      id: '1',
      ok: true,
      result: {
        sessions: [{ id: 's2' }],
        issues: [],
        fingerprint: 'fp-2'
      },
      _meta: { runtimeId: 'r1' }
    }))

    const result = await scanMobileAgentSessions(client, {
      scopePaths: ['/repo'],
      force: true,
      previous
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.params).not.toHaveProperty('afterFingerprint')
    expect(result.sessions).toEqual([{ id: 's2' }])
    expect(result.fingerprint).toBe('fp-2')
  })

  it('falls back to full scan if unchanged is returned without a matching previous snapshot', async () => {
    let callCount = 0
    const { client, calls } = fakeClient(() => {
      callCount += 1
      if (callCount === 1) {
        return {
          id: '1',
          ok: true,
          result: { sessions: [], issues: [], fingerprint: 'fp-unexpected', unchanged: true },
          _meta: { runtimeId: 'r1' }
        }
      }
      return {
        id: '2',
        ok: true,
        result: { sessions: [{ id: 'recovered' }], issues: [], fingerprint: 'fp-recovered' },
        _meta: { runtimeId: 'r1' }
      }
    })

    const result = await scanMobileAgentSessions(client, {
      scopePaths: ['/repo'],
      force: false,
      previous: null
    })

    expect(calls).toHaveLength(2)
    expect(result.sessions).toEqual([{ id: 'recovered' }])
    expect(result.fingerprint).toBe('fp-recovered')
  })

  it('propagates rpc errors without swallowing', async () => {
    const { client } = fakeClient(() => ({
      id: '1',
      ok: false,
      error: { code: 'fatal', message: 'Vault corrupt' },
      _meta: { runtimeId: 'r1' }
    }))

    await expect(
      scanMobileAgentSessions(client, { scopePaths: ['/repo'], force: false })
    ).rejects.toThrow()
  })
})
