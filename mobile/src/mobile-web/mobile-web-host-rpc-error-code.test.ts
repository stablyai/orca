/**
 * A host RPC the running page will never reach used to arrive as `host_error`, which the bridge
 * marks retryable. The page's cached package is keyed per host and opens before any refresh, so it
 * can drive a desktop release that predates or postdates it; every method that host lacks answers
 * `method_not_found`, and the mobile allowlist answers `forbidden`. Both are structural absences,
 * not blips.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import {
  isRetryableMobileWebBridgeError,
  mobileWebBridgeErrorCode,
  mobileWebBridgeErrorCodeForHostRpc,
  mobileWebBrokerHostRpcError
} from './mobile-web-broker-error'

const GRANT_LIMITS = {
  maxRequestBytes: 4096,
  maxResponseBytes: 128 * 1024,
  maxConcurrent: 2,
  rateCapacity: 8,
  rateRefillPerSecond: 4
}

function failingClient(code: string): RpcClient {
  return {
    sendRequest: vi.fn(async () => ({
      id: 'r1',
      ok: false as const,
      error: { code, message: `Method 'accounts.list' is not available` },
      _meta: { runtimeId: 'runtime-1' }
    })),
    subscribe: vi.fn(() => () => {})
  } as unknown as RpcClient
}

describe('host RPC error codes', () => {
  it.each([
    ['method_not_found', 'unsupported_capability'],
    ['method_not_supported', 'unsupported_capability'],
    ['forbidden', 'unsupported_capability'],
    ['runtime_error', 'host_error'],
    ['', 'host_error']
  ])('maps host code %s to %s', (code, expected) => {
    expect(mobileWebBridgeErrorCodeForHostRpc({ code })).toBe(expected)
    expect(mobileWebBridgeErrorCode(mobileWebBrokerHostRpcError({ code }))).toBe(expected)
  })

  it('keeps a structural absence non-retryable and a genuine host failure retryable', () => {
    expect(isRetryableMobileWebBridgeError(mobileWebBridgeErrorCodeForHostRpc({}))).toBe(true)
    expect(
      isRetryableMobileWebBridgeError(
        mobileWebBridgeErrorCodeForHostRpc({ code: 'method_not_found' })
      )
    ).toBe(false)
    expect(
      isRetryableMobileWebBridgeError(mobileWebBridgeErrorCodeForHostRpc({ code: 'forbidden' }))
    ).toBe(false)
  })

  it('tolerates a non-string host code', () => {
    expect(mobileWebBridgeErrorCodeForHostRpc({ code: 42 })).toBe('host_error')
  })

  it.each([
    ['method_not_found', 'unsupported_capability', false],
    ['forbidden', 'unsupported_capability', false],
    ['runtime_error', 'host_error', true]
  ])('reports %s to the page as %s', async (code, expected, retryable) => {
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: [{ capability: 'account', operation: 'snapshot', limits: GRANT_LIMITS }],
      rpcClient: failingClient(code)
    })

    await expect(client.account.snapshot()).rejects.toMatchObject({ code: expected, retryable })
  })
})
