import { describe, expect, it, vi } from 'vitest'
import { MobileWebAccountRequestClient } from './mobile-web-account-request-client'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

const SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function fixture(result: unknown) {
  const request = vi.fn().mockResolvedValue(result)
  const subscribeHost = vi.fn().mockReturnValue({ ready: Promise.resolve(), unsubscribe() {} })
  return {
    request,
    subscribeHost,
    client: new MobileWebAccountRequestClient(
      { request } as unknown as MobileWebOneShotRequestClient,
      { subscribeHost } as unknown as MobileWebBridgeSubscriptionClient
    )
  }
}

function hostCall(method: string, params: unknown) {
  return [
    'workspace',
    'hostRequest',
    { method, params },
    expect.anything(),
    expect.anything(),
    undefined
  ]
}

describe('host-forwarded account requests', () => {
  it('reads accounts.list and drops the desktop fields the page has no schema for', async () => {
    const f = fixture({
      ...SNAPSHOT,
      gemini: { accounts: [] },
      minimaxCookieConfigured: true,
      claude: {
        accounts: [{ id: 'a', email: 'user@example.com', credentialSource: '/private/creds' }],
        activeAccountId: 'a'
      }
    })

    const snapshot = await f.client.snapshot()
    expect(snapshot.claude.accounts).toEqual([{ id: 'a', email: 'user@example.com' }])
    expect(JSON.stringify(snapshot)).not.toContain('private')
    expect(f.request).toHaveBeenCalledWith(...hostCall('accounts.list', { refreshUsage: true }))
  })

  it('rejects a snapshot the page schema cannot read', async () => {
    await expect(fixture({ claude: {} }).client.snapshot()).rejects.toMatchObject({
      code: 'invalid_message'
    })
  })

  it.each([
    [{ provider: 'claude' as const, accountId: 'a' }, 'accounts.selectClaude', { accountId: 'a' }],
    [{ provider: 'codex' as const, accountId: 'a' }, 'accounts.selectCodex', { accountId: 'a' }],
    [
      {
        provider: 'codex' as const,
        accountId: 'a',
        codexTarget: { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
      },
      'accounts.selectCodexForTarget',
      { accountId: 'a', target: { runtime: 'wsl', wslDistro: 'Ubuntu' } }
    ]
  ])('routes %j to %s', async (payload, method, params) => {
    const f = fixture({})
    await expect(f.client.select(payload)).resolves.toBeNull()
    expect(f.request).toHaveBeenCalledWith(...hostCall(method, params))
  })

  it('parses each accounts.subscribe frame and reports one it cannot read', () => {
    const f = fixture({})
    const events: unknown[] = []
    const errors: unknown[] = []
    f.client.subscribe(
      (event) => events.push(event),
      (error) => errors.push(error)
    )
    const onEvent = f.subscribeHost.mock.calls[0]![1] as (event: unknown) => void

    expect(f.subscribeHost.mock.calls[0]![0]).toEqual({
      method: 'accounts.subscribe',
      params: {}
    })
    onEvent({ type: 'ready', subscriptionId: 'accounts-private-1', snapshot: SNAPSHOT })
    onEvent({ type: 'snapshot', snapshot: { claude: {} } })
    onEvent({ type: 'end' })

    expect(events).toEqual([{ type: 'ready', snapshot: SNAPSHOT }, { type: 'end' }])
    expect(errors).toMatchObject([{ code: 'invalid_message' }])
    expect(JSON.stringify(events)).not.toContain('accounts-private-1')
  })
})
