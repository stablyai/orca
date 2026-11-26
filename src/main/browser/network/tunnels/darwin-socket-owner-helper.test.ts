import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { runProcess, spawnProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setDarwinSocketOwnerHelperPathForTests } from './darwin-socket-owner-helper'
import {
  assertSocksClientOwnerLookup,
  holdSocksClientOwnerLookup,
  verifySocksClientOwner
} from './remote-browser-socks-client-owner'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  setDarwinSocketOwnerHelperPathForTests(null)
})

describe.skipIf(process.platform !== 'darwin')('the macOS connection owner check', () => {
  let dir = ''
  let helper = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-socket-owner-'))
    helper = join(dir, 'orca-socket-owner')
    const built = await runProcess({
      program: 'swiftc',
      args: [
        '-O',
        join(__dirname, '../../../../../native/socket-owner-macos/main.swift'),
        '-o',
        helper
      ],
      timeoutMs: 120_000
    })
    expect(built.code, built.stderr).toBe(0)
  }, 150_000)
  afterAll(() => rm(dir, { recursive: true, force: true }))

  async function acceptFromChild(host: string): Promise<{ socket: Socket; endClient: () => void }> {
    let endClient = (): void => {}
    const accepted = new Promise<Socket>((resolve) => {
      const server: Server = createServer(resolve)
      cleanups.push(() => new Promise((done) => server.close(done)))
      server.listen(0, host, () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        // Another process of this account, as a browser would be.
        const child = spawnProcess({
          program: process.execPath,
          args: [
            '-e',
            "const s = require('node:net').connect(Number(process.env.PORT), process.env.HOST, () => console.log('connected')); process.stdin.on('end', () => s.destroy()); process.stdin.resume()"
          ],
          env: { ...process.env, PORT: String(port), HOST: host },
          stdio: 'pipe'
        })
        endClient = () => child.stdin.end()
        cleanups.push(endClient)
        void createInterface({ input: child.stdout })[Symbol.asyncIterator]().next()
      })
    })
    const socket = await accepted
    cleanups.push(() => socket.destroy())
    return { socket, endClient }
  }

  it("admits this account's connections and refuses one it can't find", async () => {
    setDarwinSocketOwnerHelperPathForTests(helper)
    await assertSocksClientOwnerLookup('port forward')
    cleanups.push(holdSocksClientOwnerLookup())
    for (const host of ['127.0.0.1', '::1']) {
      const { socket, endClient } = await acceptFromChild(host)
      await expect(verifySocksClientOwner(socket)).resolves.toEqual({ allowed: true })
      // With the client gone, only the listener's accepted copy is left, and that never vouches.
      const ended = new Promise((resolve) => socket.once('end', resolve))
      socket.resume()
      endClient()
      await ended
      await expect(verifySocksClientOwner(socket)).resolves.toMatchObject({
        allowed: false,
        reason: 'lookup-failed'
      })
    }
  })

  it('refuses to start and refuses connections when the helper is missing or stopped', async () => {
    setDarwinSocketOwnerHelperPathForTests(join(dir, 'missing'))
    await expect(assertSocksClientOwnerLookup('port forward')).rejects.toThrow(
      /macOS socket owner helper is missing/
    )
    const socket = {
      localAddress: '127.0.0.1',
      localPort: 40000,
      remoteAddress: '127.0.0.1',
      remotePort: 54321
    }
    await expect(verifySocksClientOwner(socket)).resolves.toMatchObject({
      allowed: false,
      reason: 'lookup-failed'
    })

    setDarwinSocketOwnerHelperPathForTests(helper)
    const release = holdSocksClientOwnerLookup()
    release()
    // No listener holds the helper after its last release, so nothing is admitted.
    await expect(verifySocksClientOwner(socket)).resolves.toMatchObject({
      allowed: false,
      reason: 'lookup-failed'
    })
  })
})
