import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { PinnedPortUnavailableError } from './rpc/ws-transport'

const holders: Server[] = []

async function holdPort(): Promise<number> {
  const holder = createServer()
  holders.push(holder)
  await new Promise<void>((resolve) => holder.listen(0, '0.0.0.0', resolve))
  const address = holder.address()
  if (!address || typeof address === 'string') {
    throw new Error('holder has no TCP port')
  }
  return address.port
}

afterEach(async () => {
  await Promise.all(
    holders.splice(0).map((holder) => new Promise((resolve) => holder.close(resolve)))
  )
})

function serveServer(wsPort: number, requirePinnedWsPort: boolean): OrcaRuntimeRpcServer {
  return new OrcaRuntimeRpcServer({
    methods: [],
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-pinned-')),
    enableWebSocket: true,
    exposeNetworkByDefault: true,
    wsPort,
    preferPinnedWsPort: true,
    requirePinnedWsPort
  })
}

describe('orca serve --port', () => {
  it('fails startup when the requested port is taken instead of serving on another port', async () => {
    const port = await holdPort()
    const server = serveServer(port, true)
    const started = server.start()
    await expect(started).rejects.toBeInstanceOf(PinnedPortUnavailableError)
    await expect(started).rejects.toThrow(`Port ${port}`)
    expect(server.getWebSocketEndpoint()).toBeNull()
    await server.stop()
  })

  it('binds the requested port when it is free', async () => {
    const port = await holdPort()
    await new Promise((resolve) => holders.pop()!.close(resolve))
    const server = serveServer(port, true)
    await server.start()
    expect(server.getWebSocketEndpoint()).toContain(`:${port}`)
    await server.stop()
  })

  it('still falls back for a pinned-but-not-required port', async () => {
    const port = await holdPort()
    const server = serveServer(port, false)
    await server.start()
    const endpoint = server.getWebSocketEndpoint()
    expect(endpoint).not.toBeNull()
    expect(endpoint).not.toContain(`:${port}`)
    await server.stop()
  })
})
