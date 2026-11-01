import { describe, expect, it, vi } from 'vitest'
import type { BrowserTunnelFrameChannel } from './browser-tunnel-frame-channel'
import type { RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'

function session(withTunnel = true) {
  const listeners = new Set<(frame: Uint8Array) => void>()
  const send = vi.fn<BrowserTunnelFrameChannel['send']>(() => true)
  const client: RpcClient = {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn(),
    ...(withTunnel
      ? {
          browserTunnel: {
            send,
            onFrame: (listener) => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            }
          }
        }
      : {})
  }
  return {
    client,
    send,
    emit: (frame: Uint8Array) => listeners.forEach((listener) => listener(frame))
  }
}

describe('logical client browser tunnel', () => {
  it('sends on the active socket and hears only from it once it sends there', async () => {
    const first = session()
    const second = session()
    const logical = createStableLogicalRpcClient(first.client, 'lan')
    const received: number[] = []
    logical.browserTunnel?.onFrame((frame) => received.push(frame[0]!))

    expect(logical.browserTunnel?.send(new Uint8Array([9]))).toBe(true)
    first.emit(new Uint8Array([1]))

    await logical.migrateTo(second.client, 'tailscale')
    logical.browserTunnel?.send(new Uint8Array([9]))
    first.emit(new Uint8Array([2]))
    second.emit(new Uint8Array([3]))

    expect(received).toEqual([1, 3])
    expect(first.send).toHaveBeenCalledOnce()
    expect(second.send).toHaveBeenCalledOnce()
  })

  it('refuses frames on a socket without a tunnel, such as the relay', async () => {
    const logical = createStableLogicalRpcClient(session().client, 'lan')
    await logical.migrateTo(session(false).client, 'relay')
    expect(logical.browserTunnel?.send(new Uint8Array([9]))).toBe(false)
  })
})
