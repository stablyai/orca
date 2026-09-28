import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { connect, createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenOnFreeLoopbackPort, OauthCallbackForwarder } from './ssh-oauth-callback-forward'

let remote: HttpServer | null = null
let forwarder: OauthCallbackForwarder | null = null
const seen: string[] = []

// Why a local HTTP server: it stands in for the CLI listening on the remote host's loopback.
async function startRemote(): Promise<number> {
  const port = await listenOnFreeLoopbackPort()
  remote = createHttpServer((req, res) => {
    seen.push(req.url ?? '')
    res.end('signed in')
  })
  await new Promise<void>((resolve) => remote!.listen(port, '127.0.0.1', resolve))
  return port
}

function makeForwarder(
  remotePort: number,
  options: { lifetimeMs?: number; maxStrays?: number } = {}
) {
  const close = vi.fn()
  const openStream = vi.fn(async () => {
    const stream = connect(remotePort, '127.0.0.1')
    stream.once('close', close)
    return stream
  })
  forwarder = new OauthCallbackForwarder({
    canReach: () => true,
    openStream,
    idleMs: 2_000,
    ...options
  })
  return { forwarder, close, openStream }
}

async function get(port: number, path: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return res.text()
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })
}

afterEach(async () => {
  forwarder?.stopAll()
  forwarder = null
  await new Promise<void>((resolve) => (remote ? remote.close(() => resolve()) : resolve()))
  remote = null
  seen.length = 0
})

describe('OauthCallbackForwarder', () => {
  it('carries the one callback request to the remote listener, then stops listening', async () => {
    const remotePort = await startRemote()
    const { forwarder, close } = makeForwarder(remotePort)
    const port = await listenOnFreeLoopbackPort()

    const started = await forwarder.start('t1', { host: 'localhost', port, path: '/auth/callback' })

    expect(started).toEqual({ ok: true, port, lifetimeMs: 300_000 })
    expect(await get(port, '/auth/callback?code=abc&state=s')).toBe('signed in')
    expect(seen).toEqual(['/auth/callback?code=abc&state=s'])
    expect(await refused(port)).toBe(true)
    // Why the wait: fetch keeps the connection alive, so the tunnel closes at the idle timeout.
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 5_000 })
  })

  it('never passes a request for another path to the remote host', async () => {
    const remotePort = await startRemote()
    const { forwarder, openStream } = makeForwarder(remotePort)
    const port = await listenOnFreeLoopbackPort()
    await forwarder.start('t1', { host: 'localhost', port, path: '/auth/callback' })

    await expect(get(port, '/admin')).rejects.toThrow()
    expect(seen).toEqual([])
    expect(openStream).not.toHaveBeenCalled()
    // Still waiting for the real callback.
    expect(await get(port, '/auth/callback?code=1')).toBe('signed in')
  })

  it('gives up after too many stray connections', async () => {
    const remotePort = await startRemote()
    const { forwarder, openStream } = makeForwarder(remotePort, { maxStrays: 2 })
    const port = await listenOnFreeLoopbackPort()
    await forwarder.start('t1', { host: 'localhost', port, path: '/cb' })

    await expect(get(port, '/a')).rejects.toThrow()
    await expect(get(port, '/b')).rejects.toThrow()

    await vi.waitFor(async () => expect(await refused(port)).toBe(true))
    expect(openStream).not.toHaveBeenCalled()
  })

  it('fails closed with the reason when the callback port is taken here', async () => {
    const remotePort = await startRemote()
    const { forwarder, openStream } = makeForwarder(remotePort)
    const blocker = createServer()
    const port = await listenOnFreeLoopbackPort()
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve))
    try {
      expect(await forwarder.start('t1', { host: 'localhost', port, path: '/cb' })).toEqual({
        ok: false,
        reason: 'port_in_use'
      })
      expect(openStream).not.toHaveBeenCalled()
    } finally {
      blocker.close()
    }
  })

  it('fails closed without taking the port when the host cannot be reached', async () => {
    const openStream = vi.fn()
    const forwarder = new OauthCallbackForwarder({ canReach: () => false, openStream })
    const port = await listenOnFreeLoopbackPort()
    expect(await forwarder.start('t1', { host: 'localhost', port, path: '/cb' })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(await refused(port)).toBe(true)
    expect(openStream).not.toHaveBeenCalled()
  })

  it('drops the callback when the host went away before it arrived', async () => {
    const forwarder = new OauthCallbackForwarder({
      canReach: () => true,
      openStream: async () => {
        throw new Error('SSH connection is not established')
      }
    })
    const port = await listenOnFreeLoopbackPort()
    await forwarder.start('t1', { host: 'localhost', port, path: '/cb' })
    await expect(get(port, '/cb')).rejects.toThrow()
    expect(await refused(port)).toBe(true)
  })

  it('releases the port as soon as its host is disconnected', async () => {
    const remotePort = await startRemote()
    const { forwarder } = makeForwarder(remotePort)
    const port = await listenOnFreeLoopbackPort()
    await forwarder.start('t1', { host: 'localhost', port, path: '/cb' })
    forwarder.stopForTarget('t2')
    expect(await refused(port)).toBe(false)

    forwarder.stopForTarget('t1')

    expect(await refused(port)).toBe(true)
  })

  it('closes on its own when the sign-in never comes back', async () => {
    const remotePort = await startRemote()
    const { forwarder } = makeForwarder(remotePort, { lifetimeMs: 50 })
    const port = await listenOnFreeLoopbackPort()
    await forwarder.start('t1', { host: 'localhost', port, path: '/cb' })

    await vi.waitFor(async () => expect(await refused(port)).toBe(true))
  })

  it('keeps at most one callback forward per host', async () => {
    const remotePort = await startRemote()
    const { forwarder } = makeForwarder(remotePort)
    const first = await listenOnFreeLoopbackPort()
    await forwarder.start('t1', { host: 'localhost', port: first, path: '/cb' })
    const second = await listenOnFreeLoopbackPort()
    await forwarder.start('t1', { host: 'localhost', port: second, path: '/cb' })

    expect(await refused(first)).toBe(true)
    expect(await get(second, '/cb')).toBe('signed in')
  })
})
