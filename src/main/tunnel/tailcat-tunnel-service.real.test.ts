import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { RemoteRuntimeTunnelAgent } from '../../shared/remote-runtime-tunnel-dialer'
import { resolveTailcatBinary } from './tailcat-binary'
import { TailcatTunnelService } from './tailcat-tunnel-service'

const binary = process.env.ORCA_TEST_TAILCAT === '0' ? null : resolveTailcatBinary()

/**
 * Runs only where a real tailcat CLI is installed. It bootstraps through Tailcat's public relay, so
 * it needs outbound network access; CI without tailcat skips it.
 */
describe.skipIf(!binary)('TailcatTunnelService with the real tailcat CLI', () => {
  const cleanups: (() => Promise<void> | void)[] = []

  afterAll(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  it('shares a local WebSocket server and reaches it through the proxy', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    const port = (wss.address() as AddressInfo).port
    wss.on('connection', (socket) => {
      socket.on('message', (data) => socket.send(`echo:${data.toString()}`))
    })

    const host = new TailcatTunnelService({
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-tailcat-host-'))
    })
    const client = new TailcatTunnelService({
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-tailcat-client-'))
    })
    cleanups.push(() => host.stop())
    cleanups.push(() => client.stop())

    // Why: the behavioral probe must pass on a real 0.4 CLI before any child is supervised.
    const status = await host.getStatus()
    expect(status).toMatchObject({ installed: true, compatible: true, incompatibleReason: null })
    expect(status.version).toMatch(/^v?\d+\.\d+/)

    const token = await host.ensureServer(port)
    expect(token.startsWith('tc')).toBe(true)
    // Why: the short token must fit the SOCKS5 domain field the client dials it through.
    expect(token.length).toBeLessThanOrEqual(255)
    expect(host.getPairingTunnel(port)).toEqual({ v: 1, kind: 'tailcat', token })
    // Why: the same key must yield the same token, or pairing links would die with every restart.
    await host.stopServer()
    expect(await host.ensureServer(port)).toBe(token)

    const ws = new WebSocket('ws://127.0.0.1:1', {
      agent: new RemoteRuntimeTunnelAgent({ v: 1, kind: 'tailcat', token, port }, client.dial)
    })
    cleanups.push(() => ws.terminate())
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once('error', reject)
      ws.once('open', () => ws.send('hi'))
      ws.once('message', (data) => resolve(data.toString()))
    })
    expect(reply).toBe('echo:hi')
  }, 120_000)
})
