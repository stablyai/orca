import { describe, expect, it, vi } from 'vitest'
import { MobileBrowserTunnelConnection } from './mobile-browser-tunnel-connection'
import type { RpcBinaryChannelOptions, RpcBinaryClient } from './rpc-binary-channel'
import type { ConnectionState, RpcResponse } from './types'

function harness() {
  let channel: RpcBinaryChannelOptions | undefined
  let response: ((value: RpcResponse) => void) | undefined
  let state: ((value: ConnectionState) => void) | undefined
  const client: RpcBinaryClient = {
    sendBinary: vi.fn(() => true),
    sendRequest: vi.fn(),
    subscribe: (_method, _params, _listener, options) => {
      response = options?.onResponse
      return vi.fn()
    },
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: (listener) => {
      state = listener
      return vi.fn()
    },
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  const createSocket = vi.fn(() => ({
    destroyed: false,
    pushBytes: () => true,
    onReadableEnd: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn()
  }))
  const abort = new AbortController()
  const connection = new MobileBrowserTunnelConnection({
    attach: {
      authorityRuntimeId: 'runtime',
      authorityEpoch: 'epoch',
      browserHostClientId: 'host',
      browserHostGeneration: 2,
      executionHost: {
        kind: 'ssh',
        targetId: 'remote',
        providerEpoch: 'provider',
        connectionGeneration: 3
      }
    },
    connect: (options) => {
      channel = options
      return client
    },
    createSocket,
    outboundMemory: { claimApplicationBytes: () => () => {} },
    minimumTunnelGeneration: 3,
    signal: abort.signal
  })
  return {
    connection,
    client,
    abort,
    createSocket,
    ready: (generation = 4, runtimeId = 'runtime') =>
      response?.({
        id: 'stream',
        ok: true,
        streaming: true,
        result: { type: 'ready', tunnelGeneration: generation },
        _meta: { runtimeId }
      }),
    failure: (code: string) =>
      response?.({ id: 'stream', ok: false, error: { code, message: 'refused' } }),
    binary: (bytes: Uint8Array) => channel?.onBinary(bytes),
    state: (value: ConnectionState) => state?.(value)
  }
}

describe('mobile browser tunnel incarnation', () => {
  it.each(['forbidden', 'method_not_found'])('treats %s as unavailable', async (code) => {
    const h = harness()
    h.failure(code)
    await expect(h.connection.ready).resolves.toBeNull()
    expect(h.client.close).toHaveBeenCalledOnce()
  })
  it.each(['unauthorized', 'runtime_error'])('keeps %s as a genuine failure', async (code) => {
    const h = harness()
    h.failure(code)
    await expect(h.connection.ready).rejects.toThrow(code)
    expect(h.client.close).toHaveBeenCalledOnce()
  })
  it.each([
    [3, 'runtime'],
    [4, 'different-runtime']
  ] as const)('rejects stale generation or wrong authority', async (generation, runtime) => {
    const h = harness()
    h.ready(generation, runtime)
    await expect(h.connection.ready).rejects.toThrow()
    expect(h.client.close).toHaveBeenCalledOnce()
  })
  it('cancels an attach and ignores its late reply', async () => {
    const h = harness()
    h.abort.abort()
    h.ready()
    await expect(h.connection.ready).rejects.toThrow('cancelled')
    expect(h.client.close).toHaveBeenCalledOnce()
    expect(h.createSocket).not.toHaveBeenCalled()
  })
  it('retires the tunnel on reconnect without replaying its old authority', async () => {
    const h = harness()
    h.ready()
    const tunnel = await h.connection.ready
    h.state('reconnecting')
    h.state('connected')
    h.ready(5)
    await expect(tunnel?.open({ host: 'localhost', port: 5173 })).rejects.toThrow('closed')
    expect(h.client.close).toHaveBeenCalledOnce()
  })
  it('closes on malformed binary and rejects later opens', async () => {
    const h = harness()
    h.ready()
    const tunnel = await h.connection.ready
    h.binary(new Uint8Array([1, 2, 3]))
    await expect(tunnel?.open({ host: 'localhost', port: 5173 })).rejects.toThrow('closed')
    expect(h.client.close).toHaveBeenCalledOnce()
  })
})
