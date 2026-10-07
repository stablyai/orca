import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry, type DeviceScope } from './device-registry'
import { bandwidthResponse } from '../../shared/remote-runtime-bandwidth-fixture'
import {
  decodeRuntimeSnapshotResponse,
  RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY
} from '../../shared/remote-runtime-snapshot-compression'

describe('authenticated snapshot dispatch', () => {
  it.each([
    ['runtime', true],
    ['runtime', false],
    ['mobile', true]
  ] as const)(
    'gates compression for %s scope with negotiation=%s',
    async (scope: DeviceScope, negotiated) => {
      const userDataPath = await mkdtemp(join(tmpdir(), 'orca-snapshot-dispatch-'))
      const runtime = new OrcaRuntimeService()
      const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
      const registry = new DeviceRegistry(userDataPath)
      server['deviceRegistry'] = registry
      const device = registry.addDevice('snapshot-test', scope)
      const original = bandwidthResponse(1)
      const dispatch = vi
        .spyOn(server['dispatcher'], 'dispatchStreaming')
        .mockImplementation(async (_request, reply) => {
          reply(original)
        })
      const reply = vi.fn()
      const transport = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      await once(transport, 'listening')
      const address = transport.address()
      if (!address || typeof address === 'string') {
        throw new Error('Expected loopback TCP address')
      }
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
      await once(socket, 'open')
      try {
        await server['handleWebSocketMessage'](
          JSON.stringify({ id: 'subscription', method: 'session.tabs.subscribe', params: {} }),
          reply,
          () => {},
          undefined,
          undefined,
          device.token,
          {
            ws: socket,
            connectionId: 'snapshot-test',
            device: { deviceId: device.deviceId, deviceToken: device.token, scope },
            clientCapabilities: negotiated ? [RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY] : [],
            transport: { transport: 'direct' }
          }
        )
        expect(dispatch).toHaveBeenCalledOnce()
        expect(dispatch.mock.calls[0]?.[2]).toMatchObject({ clientKind: scope })
        expect(reply).toHaveBeenCalledOnce()
        const response: string = reply.mock.calls[0]![0]
        if (scope === 'runtime' && negotiated) {
          expect(response.length).toBeLessThan(original.length)
          expect(decodeRuntimeSnapshotResponse(JSON.parse(response), true)).toEqual(
            JSON.parse(original)
          )
        } else {
          expect(response).toBe(original)
        }
      } finally {
        socket.close()
        await once(socket, 'close')
        await new Promise<void>((resolve) => transport.close(() => resolve()))
        dispatch.mockRestore()
        await server.stop()
        await rm(userDataPath, { recursive: true, force: true })
      }
    }
  )
})
