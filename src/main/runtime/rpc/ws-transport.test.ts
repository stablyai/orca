import 'node:events'
import { connect } from 'node:net'
import { describe, expect, it, afterEach, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'
import './node-websocket-lifecycle'

describe('WebSocketTransport', () => {
  const transports: WebSocketTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop().catch(() => {})))
    transports.length = 0
  })

  async function createTransport(
    handler?: (msg: string, reply: (response: string) => void) => void,
    options: { preAuthTimeoutMs?: number } = {}
  ) {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      // Port 0 reserves atomically; probed free ports can race.
      port: 0,
      preAuthTimeoutMs: options.preAuthTimeoutMs
    })
    if (handler) {
      transport.onMessage(handler)
    }
    transports.push(transport)
    return { transport }
  }

  function connectWs(target: number | WebSocketTransport): Promise<WebSocket> {
    const port = typeof target === 'number' ? target : target.resolvedPort
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  it('rejects oversized messages by closing the connection', async () => {
    const { transport } = await createTransport()

    await transport.start()

    const ws = await connectWs(transport)

    const oversized = 'x'.repeat(1024 * 1024 + 100)

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.send(oversized)
    })
  })

  it('terminates every active connection for a revoked client id', async () => {
    const { transport } = await createTransport()
    const closedClientIds: (string | null)[] = []
    transport.onConnectionClose((clientId) => {
      closedClientIds.push(clientId)
    })

    await transport.start()

    const clients = await Promise.all([connectWs(transport), connectWs(transport)])
    const wss = (transport as unknown as { wss: { clients: Set<WebSocket> } }).wss
    for (const client of wss.clients) {
      transport.setClientId(client, 'device-token')
    }

    expect(transport.terminateClientConnections('device-token')).toBe(2)

    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve) => {
            if (client.readyState === client.CLOSED) {
              resolve()
              return
            }
            client.once('close', () => resolve())
          })
      )
    )

    await expect
      .poll(() => closedClientIds, { timeout: 2_000, interval: 20 })
      .toEqual(['device-token', 'device-token'])
  })

  it('reaps silent pre-auth sockets so they cannot hold the connection cap', async () => {
    const { transport } = await createTransport(undefined, { preAuthTimeoutMs: 50 })
    await transport.start()

    const clients = await Promise.all(Array.from({ length: 32 }, () => connectWs(transport)))
    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve) => {
            if (client.readyState === client.CLOSED) {
              resolve()
              return
            }
            client.once('close', () => resolve())
          })
      )
    )

    const liveClient = await connectWs(transport)
    expect(liveClient.readyState).toBe(liveClient.OPEN)
    liveClient.close()
  })

  it('drops a source the guard refuses before any HTTP or upgrade handling', async () => {
    const admit = vi.fn(() => false)
    const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0, sourceGuard: { admit } })
    transports.push(transport)
    await transport.start()

    await expect(connectWs(transport)).rejects.toThrow()
    expect(admit).toHaveBeenCalledWith('127.0.0.1')
  })

  it('stops while an HTTP client holds an unanswered request open', async () => {
    const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
    transports.push(transport)
    await transport.start()
    const socket = connect(transport.resolvedPort, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.on('error', () => {})
    // Why: the server's automatic 100 Continue proves the request is parsed and in flight.
    const continued = new Promise<void>((resolve) => socket.once('data', () => resolve()))
    socket.write(
      'POST /unanswered HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1\r\nExpect: 100-continue\r\n\r\n'
    )
    await continued

    await transport.stop()
    socket.destroy()
  })

  it('does not wait for an unresponsive client close handshake during stop', async () => {
    const { transport } = await createTransport()
    await transport.start()
    const ws = await connectWs(transport)
    const underlying = (ws as unknown as { _socket: { pause: () => void } })._socket
    underlying.pause()

    const stopPromise = transport.stop()
    const outcome = await Promise.race([
      stopPromise.then(() => 'stopped' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100))
    ])

    if (outcome === 'pending') {
      ws.terminate()
      await stopPromise
    }

    expect(outcome).toBe('stopped')
  })

  it('falls back to OS-assigned port when preferred port is in use', async () => {
    const { transport: first } = await createTransport()
    await first.start()
    const occupiedPort = first.resolvedPort

    // A conflicting port must fall back rather than fail startup.
    const second = new WebSocketTransport({
      host: '127.0.0.1',
      port: occupiedPort
    })
    transports.push(second)

    await second.start()

    expect(second.resolvedPort).not.toBe(occupiedPort)
    expect(second.resolvedPort).toBeGreaterThan(0)

    const ws = await connectWs(second.resolvedPort)
    ws.close()
  })

  it('reaps a half-open client that stops responding to pings', async () => {
    // Half-open peers otherwise occupy mobile slots for ~2h; verify heartbeat teardown through the production capacity-releasing close handler.
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: 50
    })
    transport.onMessage(() => {})
    transports.push(transport)

    let serverClosed = false
    transport.onConnectionClose(() => {
      serverClosed = true
    })

    // Stamp accepted sockets before startup so onConnectionClose sees their client ids.
    await transport.start()

    const ws = await connectWs(transport)
    // Pause TCP to block auto-pong flushing and model iOS background half-opens.
    const underlying = (ws as unknown as { _socket: { pause: () => void } })._socket
    underlying.pause()

    // Why: we need a clientId on the ws so onConnectionClose actually
    // fires. The transport sets it lazily via setClientId in production
    // (after auth); in this test we don't run auth, so reach in.
    const wss = (transport as unknown as { wss: { clients: Set<{ readyState: number }> } }).wss
    for (const c of wss.clients) {
      transport.setClientId(c as never, 'test-client')
    }

    await expect.poll(() => serverClosed, { timeout: 2_000, interval: 25 }).toBe(true)
    expect(wss.clients.size).toBe(0)
  }, 5_000)

  // Persist fallback endpoints so paired phones remain reachable across restarts (STA-1511).
  describe('fallback port stability', () => {
    async function reserveFreePort(): Promise<number> {
      const scratch = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
      await scratch.start()
      const port = scratch.resolvedPort
      await scratch.stop()
      return port
    }

    it('binds the persisted fallback port even when the preferred port is free', async () => {
      // Fallback pairings must survive even when the preferred port becomes free (STA-1511).
      const preferredPort = await reserveFreePort()
      const fallbackPort = await reserveFreePort()

      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: preferredPort,
        fallbackPort
      })
      transports.push(transport)
      await transport.start()
      expect(transport.resolvedPort).toBe(fallbackPort)
    })

    it('binds the preferred port first when preferPinnedPort is set and both are free', async () => {
      // An explicit serve --port pin must precede stale persisted fallback (#8535).
      const preferredPort = await reserveFreePort()
      const fallbackPort = await reserveFreePort()

      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: preferredPort,
        fallbackPort,
        preferPinnedPort: true
      })
      transports.push(transport)
      await transport.start()
      expect(transport.resolvedPort).toBe(preferredPort)
    })

    it('falls through to the preferred port when the fallback bind fails with a non-EADDRINUSE error', async () => {
      // Persisted ports may enter Windows Hyper-V reserved ranges; EACCES must fall back to preferred, not disable transport.
      const preferredPort = await reserveFreePort()
      const fallbackPort = await reserveFreePort()
      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: preferredPort,
        fallbackPort
      })
      transports.push(transport)
      const withListen = transport as unknown as { tryListen(port: number): Promise<void> }
      const realTryListen = withListen.tryListen.bind(transport)
      withListen.tryListen = (port: number) =>
        port === fallbackPort
          ? Promise.reject(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }))
          : realTryListen(port)

      await transport.start()
      expect(transport.resolvedPort).toBe(preferredPort)
    })

    it('tries the deterministic ladder before an OS-assigned port (#15490)', async () => {
      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: 6768,
        fallbackPort: 62944,
        fallbackLadder: [6769, 6770, 6771]
      })
      transports.push(transport)
      const attempted: number[] = []
      const withListen = transport as unknown as { tryListen(port: number): Promise<void> }
      withListen.tryListen = async (port: number) => {
        attempted.push(port)
        if (port !== 6770) {
          throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
        }
      }

      await transport.start()
      expect(attempted).toEqual([62944, 6768, 6769, 6770])
      expect(transport.persistedFallbackFailed).toBe(true)
    })
  })
})
