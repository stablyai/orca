import { createServer } from 'node:net'
import { once } from 'node:events'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { resolveWslBrowserNetworkExecutionRoute } from './wsl-browser-network-execution-route'

const runtime = process.env.BUN_EXECUTABLE
it.skipIf(!runtime)(
  'carries real TCP bytes through the built browser relay under Bun',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    let tearingDown = false
    const serverErrors: Error[] = []
    const server = createServer((socket) => {
      socket.on('error', (error) => {
        // Killing the relay may reset its TCP connection on Windows.
        if (!tearingDown || !('code' in error) || error.code !== 'ECONNRESET') {
          serverErrors.push(error)
        }
      })
      socket.pipe(socket)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing TCP listener')
    }
    const child = spawnProcess({
      program: runtime,
      args: [join(process.cwd(), 'out/relay/wsl/wsl-browser-network-relay.js')],
      env: { ORCA_BACKGROUND_LAUNCH: '1' }
    })
    child.stderr.resume()
    const closed = once(child, 'close')
    const route = await resolveWslBrowserNetworkExecutionRoute(
      {
        executionHost: {
          kind: 'wsl',
          runtimeId: 'test-runtime',
          revision: 1,
          distro: 'test-distro'
        },
        runtimeId: 'test-runtime',
        runtimeRevision: 1
      },
      { launchRelay: async () => child }
    )
    try {
      const socket = route.connect({ host: '127.0.0.1', port: address.port })
      const received = new Promise<Uint8Array>((resolve, reject) => {
        socket.on('error', reject)
        socket.on('data', resolve)
        socket.on('connect', () => socket.write(Buffer.from('Bun browser round trip')))
      })
      expect(Buffer.from(await received).toString()).toBe('Bun browser round trip')
      tearingDown = true
      socket.destroy()
    } finally {
      tearingDown = true
      await route.close()
      await closed
      await new Promise<void>((resolve) => server.close(() => resolve()))
      expect(serverErrors).toEqual([])
    }
  },
  15_000
)
