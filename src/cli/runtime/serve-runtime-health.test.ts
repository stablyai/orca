import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { connectWebSocketListener, probeServeRuntimeHealth } from './serve-runtime-health'

const metadata = {
  runtimeId: 'runtime-current',
  pid: 4101,
  authToken: 'synthetic-auth',
  startedAt: 1,
  transports: [
    { kind: 'unix' as const, endpoint: '/tmp/orca-runtime.sock' },
    { kind: 'websocket' as const, endpoint: 'ws://127.0.0.1:6768' }
  ]
}

function readyStatus() {
  return {
    id: 'local-status',
    ok: true as const,
    result: {
      app: { running: true, pid: 4101 },
      runtime: { state: 'ready' as const, reachable: true, runtimeId: 'runtime-current' },
      graph: { state: 'ready' as const }
    },
    _meta: { runtimeId: 'runtime-current' }
  }
}

describe('serve runtime health', () => {
  it('completes a real WebSocket handshake with the listener', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address() as AddressInfo

    try {
      await expect(connectWebSocketListener(`ws://127.0.0.1:${address.port}`)).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('requires the runtime RPC, ready graph, and WebSocket listener together', async () => {
    const connectWebSocket = vi.fn(async () => true)

    await expect(
      probeServeRuntimeHealth('/profile', {
        readMetadata: () => metadata,
        getStatus: async () => readyStatus(),
        connectWebSocket
      })
    ).resolves.toEqual({ healthy: true, runtimeId: 'runtime-current' })
    expect(connectWebSocket).toHaveBeenCalledWith('ws://127.0.0.1:6768')
  })

  it.each([
    {
      name: 'runtime RPC is unreachable',
      status: {
        ...readyStatus(),
        result: {
          ...readyStatus().result,
          runtime: { state: 'starting' as const, reachable: false, runtimeId: null }
        }
      },
      connect: true,
      reason: 'runtime_unreachable'
    },
    {
      name: 'graph is unavailable',
      status: {
        ...readyStatus(),
        result: {
          ...readyStatus().result,
          runtime: {
            state: 'graph_not_ready' as const,
            reachable: true,
            runtimeId: 'runtime-current'
          },
          graph: { state: 'unavailable' as const }
        }
      },
      connect: true,
      reason: 'graph_not_ready'
    },
    {
      name: 'WebSocket listener is unreachable',
      status: readyStatus(),
      connect: false,
      reason: 'websocket_unreachable'
    }
  ])('is unhealthy when $name', async ({ status, connect, reason }) => {
    await expect(
      probeServeRuntimeHealth('/profile', {
        readMetadata: () => metadata,
        getStatus: async () => status,
        connectWebSocket: async () => connect
      })
    ).resolves.toEqual({ healthy: false, reason })
  })
})
