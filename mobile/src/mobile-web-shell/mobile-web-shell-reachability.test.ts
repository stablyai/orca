import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

import { readMobileWebShellReachability } from './mobile-web-shell-reachability'

function fakeClient(): RpcClient {
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
}

const CLIENT = fakeClient()

function reachability(state: ConnectionState, client: RpcClient | null = CLIENT): string {
  return readMobileWebShellReachability(state, client)
}

describe('readMobileWebShellReachability', () => {
  it('is connected only with a live client on a connected socket', () => {
    expect(reachability('connected')).toBe('connected')
    expect(reachability('connected', null)).toBe('connecting')
  })

  it('waits through the first dial', () => {
    expect(reachability('connecting')).toBe('connecting')
    expect(reachability('handshaking')).toBe('connecting')
  })

  // A stopped desktop cycles connecting/reconnecting indefinitely; reconnecting must open verified cache instead of waiting forever.
  it('treats a scheduled retry as an unreachable host, not as a dial in progress', () => {
    expect(reachability('reconnecting')).toBe('unreachable')
  })

  it('treats a settled non-connection as unreachable', () => {
    expect(reachability('disconnected')).toBe('unreachable')
    expect(reachability('auth-failed')).toBe('unreachable')
  })
})
