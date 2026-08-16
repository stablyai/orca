import { describe, expect, it, vi } from 'vitest'
import { BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
import { BROWSER_NETWORK_TUNNEL_METHODS } from './browser-network-tunnel'

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'browser-tunnel',
    authToken: 'bound-by-websocket',
    method: 'network.browserTunnel',
    params: {
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'device-a',
      executionHost: { kind: 'native' },
      tunnelGeneration: 7,
      ...overrides
    }
  }
}

function runtime(cleanups = new Map<string, () => void>()): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
  } as unknown as OrcaRuntimeService
}

describe('network.browserTunnel RPC', () => {
  it('remains outside the production RPC registry until route authorization exists', () => {
    expect(ALL_RPC_METHODS.some((method) => method.name === 'network.browserTunnel')).toBe(false)
  })

  it('rejects an unnegotiated or mismatched browser host before registering binary traffic', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: BROWSER_NETWORK_TUNNEL_METHODS
    })
    const replies: string[] = []
    const registerBinaryMessageHandler = vi.fn()
    const baseOptions = {
      connectionId: 'connection-a',
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler
    }

    await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), baseOptions)
    await dispatcher.dispatchStreaming(
      request({ browserHostClientId: 'device-b' }),
      (reply) => replies.push(reply),
      { ...baseOptions, clientCapabilities: [BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY] }
    )

    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_tunnel_capability_required' })
      }),
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_tunnel_identity_mismatch' })
      })
    ])
    expect(registerBinaryMessageHandler).not.toHaveBeenCalled()
  })

  it('binds one raw handler to the connection and removes it during subscription cleanup', async () => {
    const cleanups = new Map<string, () => void>()
    const dispatcher = new RpcDispatcher({
      runtime: runtime(cleanups),
      methods: BROWSER_NETWORK_TUNNEL_METHODS
    })
    const unregister = vi.fn()
    const registerBinaryMessageHandler = vi.fn(() => unregister)
    const replies: string[] = []
    const dispatch = dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), {
      connectionId: 'connection-a',
      clientKind: 'runtime',
      pairedDeviceId: 'device-a',
      clientCapabilities: [BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY],
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler
    })

    await vi.waitFor(() => expect(registerBinaryMessageHandler).toHaveBeenCalledOnce())
    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      expect.objectContaining({
        ok: true,
        streaming: true,
        result: { type: 'ready', tunnelGeneration: 7 }
      })
    ])
    cleanups.get('browser-network-tunnel:connection-a')?.()
    await dispatch
    expect(unregister).toHaveBeenCalledOnce()
  })
})
