import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { RpcTransport } from './rpc/transport'

// Why: stop() is the unit under test, so transports are seeded directly instead of binding real
// listeners; the protected field is reachable through a subclass without an unchecked cast.
class TestRpcServer extends OrcaRuntimeRpcServer {
  seedTransports(transports: RpcTransport[]): void {
    this.activeTransports = transports
  }
}

function makeServer(runtime: OrcaRuntimeService, transports: RpcTransport[]): TestRpcServer {
  const server = new TestRpcServer({
    runtime,
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-shutdown-')),
    enableWebSocket: false,
    wsPort: 0
  })
  server.seedTransports(transports)
  return server
}

const okTransport: RpcTransport = { start: async () => {}, stop: async () => {} }

describe('OrcaRuntimeRpcServer.stop', () => {
  // Why: stop() empties the transport arrays before stopping them, so nothing is listening once a
  // failure surfaces. Rethrowing before clearing the port left `serve stats` advertising a dead port.
  it('clears the advertised serve port even when a transport stop rejects', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.setServePort(6970)
    const setServePort = vi.spyOn(runtime, 'setServePort')
    const server = makeServer(runtime, [
      okTransport,
      {
        start: async () => {},
        stop: async () => {
          throw new Error('transport stop failed')
        }
      }
    ])

    await expect(server.stop()).rejects.toThrow('transport stop failed')

    expect(setServePort).toHaveBeenCalledWith(null)
    expect(setServePort.mock.calls.at(-1)?.[0]).toBeNull()
  })

  it('clears the advertised serve port on a clean stop', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.setServePort(6970)
    const setServePort = vi.spyOn(runtime, 'setServePort')
    const server = makeServer(runtime, [okTransport])

    await expect(server.stop()).resolves.toBeUndefined()

    expect(setServePort).toHaveBeenCalledWith(null)
  })
})
