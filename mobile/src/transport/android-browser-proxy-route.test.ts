import { expect, it, vi } from 'vitest'
import type { BrowserLoopbackNative } from '../../modules/orca-mobile-web-shell/src/browser-loopback'
import type { RpcBinaryChannelOptions, RpcBinaryClient } from './rpc-binary-channel'
import type { ConnectionState, RpcResponse } from './types'
import { AndroidBrowserProxyRoute } from './android-browser-proxy-route'
import {
  BrowserNetworkTunnelOpcode as Op,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../../src/shared/browser-network-tunnel-protocol'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = async () => {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve()
  }
}

function harness(credit = true) {
  let retained = 0
  let response: ((value: RpcResponse) => void) | undefined
  let state: ((value: ConnectionState) => void) | undefined
  let channel: RpcBinaryChannelOptions | undefined
  const accepts: ReturnType<typeof deferred<number>>[] = []
  const reads = new Map<number, ReturnType<typeof deferred<Uint8Array | null>>>()
  const native: BrowserLoopbackNative = {
    browserProxyStart: vi.fn(async () => ({ route: 1, port: 43210 })),
    browserProxyAccept: vi.fn(() => {
      const pending = deferred<number>()
      accepts.push(pending)
      return pending.promise
    }),
    browserProxyRead: vi.fn((_route, id) => {
      const pending = deferred<Uint8Array | null>()
      reads.set(id, pending)
      return pending.promise
    }),
    browserProxyWrite: vi.fn(async () => {}),
    browserProxyCloseSocket: vi.fn(),
    browserProxyClose: vi.fn()
  }
  const send = (
    opcode: Op,
    streamId: number,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
  ) =>
    channel?.onBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, streamId, payload, tunnelGeneration: 1 })
    )
  const client: RpcBinaryClient = {
    sendBinary: vi.fn((bytes) => {
      const frame = decodeBrowserNetworkTunnelFrame(bytes)!
      queueMicrotask(() => {
        if (frame.opcode === Op.Open) {
          send(Op.Opened, frame.streamId)
          if (credit) {
            send(Op.WindowUpdate, frame.streamId, encodeBrowserNetworkTunnelWindowUpdate(65536))
          }
        }
        if (frame.opcode === Op.Data) {
          send(Op.Data, frame.streamId, frame.payload.slice())
        }
      })
      return true
    }),
    subscribe: (_method, _params, _listener, options) => {
      response = options?.onResponse
      return () => {}
    },
    onStateChange: (listener) => {
      state = listener
      return () => {}
    },
    close: vi.fn(),
    sendRequest: vi.fn(),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    notifyForeground: vi.fn()
  }
  const route = new AndroidBrowserProxyRoute(native, {
    attach: {
      authorityRuntimeId: 'runtime',
      authorityEpoch: 'epoch',
      browserHostClientId: 'host',
      browserHostGeneration: 1,
      executionHost: { kind: 'native', runtimeId: 'runtime', revision: 1 }
    },
    connect: (options) => {
      channel = options
      return client
    },
    minimumTunnelGeneration: 0,
    outboundMemory: {
      claimApplicationBytes: (bytes) => {
        retained += bytes
        return () => {
          retained -= bytes
        }
      }
    }
  })
  return {
    route,
    retained: () => retained,
    native,
    client,
    accepts,
    reads,
    state: (value: ConnectionState) => state?.(value),
    ready: () =>
      response?.({
        id: 's',
        ok: true,
        result: { type: 'ready', tunnelGeneration: 1 },
        _meta: { runtimeId: 'runtime' }
      }),
    denied: () =>
      response?.({ id: 's', ok: false, error: { code: 'forbidden', message: 'denied' } })
  }
}

it('shares one route and tunnel for two SOCKS peers and tears down on transport loss', async () => {
  const h = harness()
  h.ready()
  await expect(h.route.ready).resolves.toEqual({ host: '127.0.0.1', port: 43210 })
  for (const id of [1, 2]) {
    h.accepts.shift()!.resolve(id)
    await tick()
    h.reads.get(id)!.resolve(new Uint8Array([5, 1, 0, 5, 1, 0, 3, 3, 97, 46, 98, 0, 80, id]))
    await tick()
    expect(h.native.browserProxyWrite).toHaveBeenCalledWith(1, id, new Uint8Array([id]))
  }
  expect(h.native.browserProxyStart).toHaveBeenCalledOnce()
  h.state('disconnected')
  expect(h.native.browserProxyClose).toHaveBeenCalledExactlyOnceWith(1)
  expect(h.client.close).toHaveBeenCalledOnce()
  h.route.close()
  expect(h.native.browserProxyClose).toHaveBeenCalledOnce()
})

it('does not start native listening when admission is denied', async () => {
  const h = harness()
  h.denied()
  await expect(h.route.ready).resolves.toBeNull()
  expect(h.native.browserProxyStart).not.toHaveBeenCalled()
})

it('closes a listener returned after route disposal', async () => {
  const h = harness()
  const listener = deferred<{ route: number; port: number }>()
  vi.mocked(h.native.browserProxyStart).mockReturnValue(listener.promise)
  h.ready()
  await tick()
  h.route.close()
  listener.resolve({ route: 8, port: 43210 })
  await expect(h.route.ready).resolves.toBeNull()
  expect(h.native.browserProxyClose).toHaveBeenCalledExactlyOnceWith(8)
})

it('settles every peer and RPC when native route disposal throws', async () => {
  const h = harness(false)
  h.ready()
  await h.route.ready
  for (const id of [1, 2]) {
    h.accepts.shift()!.resolve(id)
    await tick()
    h.reads.get(id)!.resolve(new Uint8Array([5, 1, 0, 5, 1, 0, 3, 3, 97, 46, 98, 0, 80, id]))
    await tick()
  }
  expect(h.retained()).toBe(2)
  vi.mocked(h.native.browserProxyClose).mockImplementation(() => {
    throw new Error('Module destroyed')
  })
  expect(() => h.route.close()).not.toThrow()
  expect(h.retained()).toBe(0)
  h.route.close()
  expect(h.client.close).toHaveBeenCalledOnce()
  expect(h.native.browserProxyClose).toHaveBeenCalledOnce()
})

it('ignores throwing cleanup of a listener returned after module teardown', async () => {
  const h = harness()
  const listener = deferred<{ route: number; port: number }>()
  vi.mocked(h.native.browserProxyStart).mockReturnValue(listener.promise)
  vi.mocked(h.native.browserProxyClose).mockImplementation(() => {
    throw new Error('Obsolete route')
  })
  h.ready()
  await tick()
  h.route.close()
  listener.resolve({ route: 8, port: 43210 })
  await expect(h.route.ready).resolves.toBeNull()
  expect(h.client.close).toHaveBeenCalledOnce()
})
