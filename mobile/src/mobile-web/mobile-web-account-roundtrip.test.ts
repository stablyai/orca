import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'

it('round trips typed account reads, selection, and snapshots through the production bridge', async () => {
  let hostListener: ((event: unknown) => void) | null = null
  const hostUnsubscribe = vi.fn()
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'accounts.list') {
      return { ok: true, result: hostSnapshot() }
    }
    return { ok: true, result: {} }
  })
  const rpcClient = {
    sendRequest,
    subscribe: vi.fn((_method, _params, listener) => {
      hostListener = listener
      return hostUnsubscribe
    })
  } as unknown as RpcClient
  const requestIds = ['A', 'B', 'C', 'D', 'E']
  let requestIndex = 0
  const { client, pageMessages, shellMessages } = createMobileWebBridgeRoundtripFixture({
    grants: [accountGrant('snapshot'), accountGrant('select'), accountGrant('subscribe')],
    rpcClient,
    createRequestId: () => requestIds[requestIndex++]!.repeat(22),
    navigationAuthority: {
      route: vi.fn(),
      reconnect: vi.fn(),
      removeHost: vi.fn()
    }
  })

  await expect(client.account.snapshot()).resolves.toMatchObject({
    claude: {
      accounts: [{ id: 'claude-1', email: 'claude@example.com' }],
      activeAccountId: 'claude-1'
    }
  })
  expect(pageMessages[0]).toMatchObject({
    type: 'request',
    requestId: 'A'.repeat(22),
    capability: 'account',
    operation: 'snapshot'
  })
  expect(shellMessages[0]).toMatchObject({
    type: 'response',
    requestId: 'A'.repeat(22),
    status: 'success'
  })
  await expect(
    client.account.select({ provider: 'codex', accountId: 'codex-1' })
  ).resolves.toBeNull()
  expect(sendRequest).toHaveBeenCalledWith('accounts.selectCodex', {
    accountId: 'codex-1'
  })

  const onEvent = vi.fn()
  const subscription = client.account.subscribe(onEvent, vi.fn())
  await subscription.ready
  hostListener?.({ type: 'snapshot', snapshot: hostSnapshot() })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce())
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'snapshot',
      snapshot: expect.objectContaining({
        codex: { accounts: [], activeAccountId: null }
      })
    })
  )
  subscription.unsubscribe()
  expect(hostUnsubscribe).toHaveBeenCalledOnce()
})

function accountGrant(operation: 'snapshot' | 'select' | 'subscribe') {
  return {
    capability: 'account' as const,
    operation,
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: 96 * 1024,
      maxConcurrent: 2,
      rateCapacity: 8,
      rateRefillPerSecond: 8
    }
  }
}

function hostSnapshot() {
  return {
    claude: {
      accounts: [{ id: 'claude-1', email: 'claude@example.com' }],
      activeAccountId: 'claude-1'
    },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}
