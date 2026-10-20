import './rpc/unused-default-rpc-methods.test-fixture'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { defineStreamingMethod } from './rpc/core'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

describe('runtime RPC browser-host admission', () => {
  it('aborts a browser host attach and a wait when their socket closes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-host-admission-'))
    const started = vi.fn()
    const aborted = vi.fn()
    const blockingMethod = (name: 'browser.clientHost.attach' | 'terminal.wait') =>
      defineStreamingMethod({
        name,
        permission: 'workspace',
        params: null,
        handler: async (_params, { signal }) => {
          started(name)
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              'abort',
              () => {
                aborted(name)
                resolve()
              },
              { once: true }
            )
          })
        }
      })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      methods: [blockingMethod('browser.clientHost.attach'), blockingMethod('terminal.wait')]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry'].addDevice('runtime-test', 'runtime')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the server reads only these wiring members in this test.
    server['mobileSocketWiring'] = {
      dispose: () => {},
      getConnectionId: () => 'connection-a'
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    const socket = new FakeWebSocket()
    const dispatch = (id: string, method: string) =>
      server['handleWebSocketMessage'](
        JSON.stringify({ id, method, deviceToken: device.token }),
        () => {},
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const host = dispatch('host-a', 'browser.clientHost.attach')
      const wait = dispatch('wait-a', 'terminal.wait')
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2))
      expect(aborted).not.toHaveBeenCalled()

      socket.readyState = 3
      socket.emit('close')
      await Promise.all([host, wait])
      expect(aborted).toHaveBeenCalledWith('browser.clientHost.attach')
      expect(aborted).toHaveBeenCalledWith('terminal.wait')
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}
