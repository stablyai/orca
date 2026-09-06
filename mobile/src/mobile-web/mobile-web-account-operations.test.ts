import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'

describe('mobile web account operations', () => {
  it('sanitizes snapshots and switches accounts through the host', async () => {
    const harness = createHarness()

    await harness.broker.handle(request('A', 'snapshot', {}))
    await harness.broker.handle(
      request('B', 'select', { provider: 'claude', accountId: 'claude-1' })
    )

    expect(successPayload(harness.messages, 'A')).toEqual(snapshotPresentation())
    expect(JSON.stringify(harness.messages)).not.toContain('/private/claude/auth.json')
    expect(JSON.stringify(harness.messages)).not.toContain('provider-account-secret')
    expect(harness.sendRequest).toHaveBeenCalledWith('accounts.selectClaude', {
      accountId: 'claude-1'
    })
    expect(successPayload(harness.messages, 'B')).toBeNull()
  })

  it('forwards bounded snapshot events and retires the host stream on client replacement', async () => {
    const harness = createHarness()
    await harness.broker.handle(subscriptionRequest())
    harness.subscriptionListener?.({ type: 'ready', snapshot: hostSnapshot() })

    await vi.waitFor(() => {
      expect(harness.messages.some((message) => message.type === 'event')).toBe(true)
    })
    expect(harness.messages.find((message) => message.type === 'event')).toMatchObject({
      type: 'event',
      sequence: 0,
      payload: { type: 'ready', snapshot: snapshotPresentation() }
    })

    harness.broker.replaceClient(null)
    expect(harness.hostUnsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps reset identity and idempotency in the native shell', async () => {
    const harness = createHarness()
    const expectedScope = {
      target: { runtime: 'host' as const, wslDistro: null },
      accountId: 'codex-1',
      accountRevision: 900,
      offerRevision: 'v1:offer'
    }

    await harness.broker.handle(request('F', 'resetCreditCapability', {}))
    expect(successPayload(harness.messages, 'F')).toBe(true)

    await harness.broker.handle(request('H', 'consumeResetCredit', { expectedScope }))
    expect(harness.codexResetCreditConsume).toHaveBeenCalledWith(expect.anything(), expectedScope)
    expect(successPayload(harness.messages, 'H')).toMatchObject({
      outcome: 'reset',
      scope: expectedScope,
      attemptJournalRetained: false
    })
    expect(JSON.stringify(harness.messages)).not.toContain('host-pairing-identity')
  })
})

function createHarness() {
  let subscriptionListener: ((event: unknown) => void) | null = null
  const hostUnsubscribe = vi.fn()
  const codexResetCreditCapability = vi.fn(async () => true)
  const codexResetCreditConsume = vi.fn(async (_client, expectedScope) => ({
    outcome: 'reset' as const,
    scope: expectedScope,
    snapshot: hostSnapshot(),
    attemptJournalRetained: false
  }))
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'accounts.list') {
      return { ok: true, result: hostSnapshot() }
    }
    return { ok: true, result: {} }
  })
  const client = {
    sendRequest,
    subscribe: vi.fn((_method, _params, listener) => {
      subscriptionListener = listener
      return hostUnsubscribe
    })
  } as unknown as RpcClient
  const { broker, messages } = createMobileWebBrokerFixture({
    getClient: () => client,
    nativeAuthority: { codexResetCreditCapability, codexResetCreditConsume },
    navigationAuthority: {
      route: vi.fn(),
      reconnect: vi.fn(),
      removeHost: vi.fn()
    }
  })
  return {
    broker,
    messages,
    sendRequest,
    hostUnsubscribe,
    codexResetCreditConsume,
    get subscriptionListener() {
      return subscriptionListener
    }
  }
}

function hostSnapshot() {
  return {
    claude: {
      accounts: [
        {
          id: 'claude-1',
          email: 'claude@example.com',
          organizationName: 'Orca',
          managedAuthPath: '/private/claude/auth.json'
        }
      ],
      activeAccountId: 'claude-1'
    },
    codex: {
      accounts: [
        {
          id: 'codex-1',
          email: 'codex@example.com',
          workspaceLabel: 'Personal',
          updatedAt: 900,
          providerAccountId: 'provider-account-secret'
        }
      ],
      activeAccountId: null
    },
    rateLimits: {
      claude: rateLimits('claude', 24),
      codex: rateLimits('codex', 12),
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

function rateLimits(provider: 'claude' | 'codex', usedPercent: number) {
  return {
    provider,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: 2_000,
      resetDescription: 'Later'
    },
    weekly: null,
    updatedAt: 1_000,
    error: null,
    status: 'ok',
    usageMetadata: { credentialSource: 'must-not-cross' }
  }
}

function snapshotPresentation() {
  return {
    claude: {
      accounts: [{ id: 'claude-1', email: 'claude@example.com', organizationName: 'Orca' }],
      activeAccountId: 'claude-1'
    },
    codex: {
      accounts: [
        {
          id: 'codex-1',
          email: 'codex@example.com',
          workspaceLabel: 'Personal',
          updatedAt: 900
        }
      ],
      activeAccountId: null
    },
    rateLimits: {
      claude: rateLimitsPresentation('claude', 24),
      codex: rateLimitsPresentation('codex', 12),
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

function rateLimitsPresentation(provider: 'claude' | 'codex', usedPercent: number) {
  return {
    provider,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: 2_000,
      resetDescription: 'Later'
    },
    weekly: null,
    updatedAt: 1_000,
    error: null,
    status: 'ok'
  }
}

function request(
  id: string,
  operation: 'snapshot' | 'select' | 'resetCreditCapability' | 'consumeResetCredit',
  payload: unknown
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return mobileWebBridgeRequestMessage({
    requestId: id.repeat(22),
    capability: 'account',
    operation,
    payload
  })
}

function subscriptionRequest(): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    ...request('D', 'snapshot', {}),
    mode: 'subscription',
    subscriptionId: 'E'.repeat(22),
    operation: 'subscribe'
  }
}

function successPayload(messages: readonly MobileWebBridgeShellMessage[], id: string): unknown {
  const message = messages.find(
    (candidate) =>
      candidate.type === 'response' &&
      candidate.requestId === id.repeat(22) &&
      candidate.status === 'success'
  )
  return message && message.type === 'response' && message.status === 'success'
    ? message.payload
    : undefined
}
