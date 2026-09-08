import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileWebSessionRequestClient } from './mobile-web-session-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

function fixture() {
  const request = vi.fn(async (capability, _operation, payload) => {
    if (capability === 'session') {
      return { workspaceId: 'workspace', tabId: 'legacy', created: true }
    }
    return payload.method.endsWith('agentOptions')
      ? { agents: ['codex', 'future-agent'] }
      : { tabId: 'tab', created: true }
  })
  const requests = { supports: () => true, request } as unknown as MobileWebOneShotRequestClient
  return { request, client: new MobileWebSessionRequestClient(requests) }
}
afterEach(() => vi.useRealTimers())
describe('host session terminal creation page integration', () => {
  it('reads future host agent names without installed-shell enum filtering', async () => {
    const f = fixture()
    expect(await f.client.agentOptions({ workspaceId: 'workspace' })).toEqual({
      agents: ['codex', 'future-agent']
    })
  })
  it.each([false, true])(
    'creates blank/agent terminal (agent=%s) over generic authority',
    async (agent) => {
      const f = fixture()
      expect(
        await (agent
          ? f.client.createAgent({ workspaceId: 'workspace', agent: 'codex' })
          : f.client.create({ workspaceId: 'workspace' }))
      ).toEqual({ workspaceId: 'workspace', tabId: 'tab', created: true })
      expect(f.request.mock.calls[0][2]).toEqual({
        method: 'mobileWeb.session.createTerminal',
        workspaceId: 'workspace',
        timeoutMs: expect.any(Number),
        params: {
          ...(agent ? { agent: 'codex' } : {}),
          clientMutationId: expect.any(String),
          timeoutMs: expect.any(Number)
        }
      })
    }
  )
  it.each(['timeout', 'unsupported_capability'] as const)(
    'does not retry creation after %s',
    async (code) => {
      const f = fixture()
      f.request.mockRejectedValueOnce(new MobileWebBridgeClientError(code, false))
      await expect(f.client.create({ workspaceId: 'workspace' })).rejects.toMatchObject({ code })
      expect(f.request.mock.calls.map((call) => call[1])).toEqual(['hostRequest'])
    }
  )
})
