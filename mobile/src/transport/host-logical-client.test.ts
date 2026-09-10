import { describe, expect, it, vi } from 'vitest'
import { FakeSession, host } from './mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from './rpc-client'
import type { HostProtocolVerificationSource } from './host-protocol-verifier'

const connectMock = vi.hoisted(() => vi.fn())

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() }))
  },
  Platform: { OS: 'web' }
}))
vi.mock('./rpc-client', () => ({
  connect: (...args: unknown[]) => connectMock(...args)
}))
// The web branch never starts the lifecycle; stub it so its native deps stay out of the test.
vi.mock('./mobile-endpoint-lifecycle', () => ({
  startMobileEndpointLifecycle: vi.fn(() => ({
    setForeground: vi.fn(),
    nudge: vi.fn(),
    stop: vi.fn()
  }))
}))

const { openHostLogicalClient } = await import('./host-logical-client')

function openWith(session: FakeSession): RpcClient & HostProtocolVerificationSource {
  connectMock.mockReturnValue(session)
  return openHostLogicalClient(host, () => {}) as RpcClient & HostProtocolVerificationSource
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('openHostLogicalClient', () => {
  // Why: admission closes every RPC in the app, so the client the provider hands out must
  // verify itself. Leaving that to a route left the launch screen permanently fenced.
  it('verifies the host it opens, with no component mounted', async () => {
    const session = new FakeSession('connected')
    session.sendRequest.mockResolvedValue({
      id: '1',
      ok: true,
      result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
    })
    const client = openWith(session)
    await settle()

    expect(session.sendRequest).toHaveBeenCalledWith('status.get', undefined, {
      timeoutMs: 8_000,
      budgetSpansConnect: true
    })
    expect(client.getVerification()).toMatchObject({ verdict: { kind: 'ok' }, pending: false })
    await expect(client.sendRequest('worktree.ps')).resolves.toMatchObject({ ok: true })
    client.close()
  })

  it('stops verifying when the client closes', async () => {
    vi.useFakeTimers()
    try {
      const session = new FakeSession('connected')
      session.sendRequest.mockRejectedValue(new Error('offline'))
      const client = openWith(session)
      await vi.advanceTimersByTimeAsync(0)
      expect(session.sendRequest).toHaveBeenCalledOnce()

      client.close()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(session.sendRequest).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
