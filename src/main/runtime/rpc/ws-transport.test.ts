import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'
import { loadOrCreateTlsCertificate } from '../tls-certificate'

// Why: disable TLS verification for self-signed certs in tests.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

function makeTls() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'ws-transport-test-'))
  return loadOrCreateTlsCertificate(userDataPath)
}

function heartbeatLifecycle(transport: WebSocketTransport) {
  return transport as unknown as {
    heartbeat: {
      timer: ReturnType<typeof setInterval> | null
      alive: WeakSet<WebSocket>
    }
    heartbeatConnections: Set<WebSocket>
    wss: { clients: Set<WebSocket> }
    handleConnection(ws: WebSocket): void
  }
}

async function waitForHeartbeatLifecycle(
  transport: WebSocketTransport,
  connectionCount: number,
  armed: boolean
): Promise<void> {
  await vi.waitFor(() => {
    const lifecycle = heartbeatLifecycle(transport)
    expect(lifecycle.heartbeatConnections.size).toBe(connectionCount)
    expect(lifecycle.heartbeat.timer !== null).toBe(armed)
  })
}

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
    const tls = makeTls()
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      // Why: random "free" ports can still collide before listen() binds.
      // Port 0 lets the OS reserve an available port atomically.
      port: 0,
      tlsCert: tls.cert,
      tlsKey: tls.key,
      preAuthTimeoutMs: options.preAuthTimeoutMs
    })
    if (handler) {
      transport.onMessage(handler)
    }
    transports.push(transport)
    return { transport, tls }
  }

  function connectWs(target: number | WebSocketTransport): Promise<WebSocket> {
    const port = typeof target === 'number' ? target : target.resolvedPort
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, {
        rejectUnauthorized: false
      })
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  function sendAndReceive(ws: WebSocket, message: string): Promise<string> {
    return new Promise((resolve) => {
      ws.once('message', (data) => {
        resolve(typeof data === 'string' ? data : data.toString('utf-8'))
      })
      ws.send(message)
    })
  }

  it('starts and stops cleanly', async () => {
    const { transport } = await createTransport()

    await transport.start()
    await transport.stop()
  })

  it('arms heartbeat only while accepted connections exist', async () => {
    const { transport } = await createTransport()
    await transport.start()

    const lifecycle = heartbeatLifecycle(transport)
    expect(lifecycle.heartbeat.timer).toBeNull()
    expect(lifecycle.heartbeatConnections.size).toBe(0)

    const firstClient = await connectWs(transport)
    await waitForHeartbeatLifecycle(transport, 1, true)
    const firstServerSocket = Array.from(lifecycle.wss.clients)[0]
    expect(firstServerSocket).toBeDefined()
    // Note: arming probes immediately, so `alive` membership is racy here (the client's protocol-level
    // pong re-adds the socket right after the arm sweep clears it). Assert the arm/disarm lifecycle only.
    const firstTimer = lifecycle.heartbeat.timer

    const secondClient = await connectWs(transport)
    await waitForHeartbeatLifecycle(transport, 2, true)
    expect(lifecycle.heartbeat.timer).toBe(firstTimer)

    firstClient.close()
    await waitForHeartbeatLifecycle(transport, 1, true)
    expect(lifecycle.heartbeat.timer).toBe(firstTimer)

    secondClient.close()
    await waitForHeartbeatLifecycle(transport, 0, false)

    const thirdClient = await connectWs(transport)
    await waitForHeartbeatLifecycle(transport, 1, true)
    expect(lifecycle.heartbeat.timer).not.toBe(firstTimer)

    thirdClient.close()
    await waitForHeartbeatLifecycle(transport, 0, false)
  })

  it('finalizes heartbeat membership once when error and close race', () => {
    const transport = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
    transports.push(transport)
    const lifecycle = heartbeatLifecycle(transport)
    const socket = Object.assign(new EventEmitter(), {
      OPEN: WebSocket.OPEN,
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn()
    }) as unknown as WebSocket
    const closeHandler = vi.fn()
    transport.onConnectionClose(closeHandler)

    lifecycle.handleConnection(socket)
    expect(lifecycle.heartbeatConnections.size).toBe(1)
    expect(lifecycle.heartbeat.timer).not.toBeNull()

    socket.emit('error', new Error('connection reset'))
    socket.emit('close')

    expect(closeHandler).toHaveBeenCalledTimes(1)
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(lifecycle.heartbeatConnections.size).toBe(0)
    expect(lifecycle.heartbeat.timer).toBeNull()
  })

  it('handles request/response round-trip', async () => {
    const { transport } = await createTransport((msg, reply) => {
      const request = JSON.parse(msg)
      reply(JSON.stringify({ id: request.id, ok: true, result: { echo: true } }))
    })

    await transport.start()

    const ws = await connectWs(transport)
    const response = await sendAndReceive(
      ws,
      JSON.stringify({ id: 'req-1', method: 'test', deviceToken: 'tok' })
    )

    expect(JSON.parse(response)).toMatchObject({
      id: 'req-1',
      ok: true,
      result: { echo: true }
    })

    ws.close()
  })

  it('supports multiple concurrent connections', async () => {
    const { transport } = await createTransport((msg, reply) => {
      const request = JSON.parse(msg)
      reply(JSON.stringify({ id: request.id, ok: true }))
    })

    await transport.start()

    const clients = await Promise.all([
      connectWs(transport),
      connectWs(transport),
      connectWs(transport)
    ])

    const responses = await Promise.all(
      clients.map((ws, i) => sendAndReceive(ws, JSON.stringify({ id: `req-${i}`, method: 'test' })))
    )

    for (let i = 0; i < 3; i++) {
      expect(JSON.parse(responses[i]!)).toMatchObject({ id: `req-${i}`, ok: true })
    }

    for (const ws of clients) {
      ws.close()
    }
  })

  it('multiplexes multiple requests on a single connection', async () => {
    const { transport } = await createTransport((msg, reply) => {
      const request = JSON.parse(msg)
      reply(JSON.stringify({ id: request.id, ok: true, result: { method: request.method } }))
    })

    await transport.start()

    const ws = await connectWs(transport)

    const r1 = sendAndReceive(ws, JSON.stringify({ id: 'a', method: 'first' }))
    const resp1 = JSON.parse(await r1)
    expect(resp1).toMatchObject({ id: 'a', result: { method: 'first' } })

    const r2 = sendAndReceive(ws, JSON.stringify({ id: 'b', method: 'second' }))
    const resp2 = JSON.parse(await r2)
    expect(resp2).toMatchObject({ id: 'b', result: { method: 'second' } })

    ws.close()
  })

  it('sends multiple streaming responses via reply callback', async () => {
    const { transport } = await createTransport((msg, reply) => {
      const request = JSON.parse(msg)
      reply(JSON.stringify({ id: request.id, ok: true, streaming: true, result: { chunk: 1 } }))
      reply(JSON.stringify({ id: request.id, ok: true, streaming: true, result: { chunk: 2 } }))
      reply(JSON.stringify({ id: request.id, ok: true, result: { type: 'end' } }))
    })

    await transport.start()

    const ws = await connectWs(transport)
    const messages: string[] = []

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        messages.push(typeof data === 'string' ? data : data.toString('utf-8'))
        if (messages.length === 3) {
          resolve()
        }
      })
      ws.send(JSON.stringify({ id: 'stream-1', method: 'terminal.subscribe' }))
    })

    expect(JSON.parse(messages[0]!)).toMatchObject({ streaming: true, result: { chunk: 1 } })
    expect(JSON.parse(messages[1]!)).toMatchObject({ streaming: true, result: { chunk: 2 } })
    expect(JSON.parse(messages[2]!)).toMatchObject({ result: { type: 'end' } })

    ws.close()
  })

  it('rejects oversized messages by closing the connection', async () => {
    const { transport } = await createTransport()

    await transport.start()

    const ws = await connectWs(transport)

    // Why: ws maxPayload is 1MB — sending >1MB should trigger close.
    const oversized = 'x'.repeat(1024 * 1024 + 100)

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.send(oversized)
    })
  })

  it('does not crash when replying to a closed connection', async () => {
    let capturedReply: ((response: string) => void) | null = null

    const { transport } = await createTransport((_msg, reply) => {
      capturedReply = reply
    })

    await transport.start()

    const ws = await connectWs(transport)
    ws.send(JSON.stringify({ id: 'req-1', method: 'test' }))

    // Why: wait for the handler to capture the reply function.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (capturedReply) {
          clearInterval(interval)
          resolve()
        }
      }, 10)
    })

    ws.close()

    // Why: wait for the WebSocket to fully close before trying to reply.
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Should not throw — guards with readyState check.
    expect(() => capturedReply!(JSON.stringify({ id: 'req-1', ok: true }))).not.toThrow()
  })

  it('runs connection cleanup for sockets that close before auth', async () => {
    const { transport } = await createTransport()
    const calls: { clientId: string | null; hasOtherConnections: boolean }[] = []
    transport.onConnectionClose((clientId, _ws, hasOtherConnections) => {
      calls.push({ clientId, hasOtherConnections })
    })

    await transport.start()

    const ws = await connectWs(transport)
    ws.close()

    const start = Date.now()
    while (calls.length === 0 && Date.now() - start < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(calls).toEqual([{ clientId: null, hasOtherConnections: false }])
  })

  it('detaches server socket listeners after client close', async () => {
    const { transport } = await createTransport()
    let cleanupSeen = false
    transport.onConnectionClose(() => {
      cleanupSeen = true
    })

    await transport.start()

    const client = await connectWs(transport)
    const wss = (transport as unknown as { wss: { clients: Set<WebSocket> } }).wss
    const serverSocket = Array.from(wss.clients)[0]
    expect(serverSocket).toBeDefined()
    const offSpy = vi.spyOn(serverSocket!, 'off')

    client.close()

    const start = Date.now()
    while (!cleanupSeen && Date.now() - start < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(cleanupSeen).toBe(true)
    const removedEvents = offSpy.mock.calls.map(([event]) => event)
    expect(removedEvents).toEqual(expect.arrayContaining(['pong', 'message', 'close', 'error']))
    offSpy.mockRestore()
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

    const start = Date.now()
    while (closedClientIds.length < 2 && Date.now() - start < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(closedClientIds).toEqual(['device-token', 'device-token'])
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

  it('bounds raw TCP sockets above the WebSocket connection budget', async () => {
    // Why: the WebSocket cap applies only after upgrade, so raw sockets need a
    // finite independent bound without reducing the 128 legitimate WS slots.
    const { transport } = await createTransport()
    await transport.start()

    const httpServer = (transport as unknown as { httpServer: { maxConnections: number } })
      .httpServer
    expect(httpServer.maxConnections).toBe(256)
  })

  it('force-terminates an over-capacity socket that ignores the close frame', async () => {
    // Why: a backgrounded/half-open phone may never ack the 1013 close, so a
    // bare ws.close() retains its descriptor until the heartbeat. A reconnect
    // flood can fill the TCP headroom during that window, so rejection must
    // hard-close on a short fixed deadline.
    const { transport } = await createTransport()
    await transport.start()

    const ws = await connectWs(transport)
    const wss = (transport as unknown as { wss: { clients: Set<WebSocket> } }).wss
    const serverSocket = Array.from(wss.clients)[0]
    expect(serverSocket).toBeDefined()
    const terminateSpy = vi.spyOn(serverSocket!, 'terminate')

    vi.useFakeTimers()
    try {
      ;(transport as unknown as { rejectOverCapacity(ws: WebSocket): void }).rejectOverCapacity(
        serverSocket!
      )
      vi.advanceTimersByTime(1_000)
    } finally {
      vi.useRealTimers()
    }

    expect(terminateSpy).toHaveBeenCalled()
    terminateSpy.mockRestore()
    ws.close()
  })

  it('is idempotent on double start', async () => {
    const { transport } = await createTransport()

    await transport.start()
    await transport.start()

    await transport.stop()
  })

  it('is safe to stop without starting', async () => {
    const { transport } = await createTransport()
    await transport.stop()
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

    // Why: second transport requests the same port, which is now occupied.
    // It should silently fall back to an OS-assigned port instead of throwing.
    const tls = makeTls()
    const second = new WebSocketTransport({
      host: '127.0.0.1',
      port: occupiedPort,
      tlsCert: tls.cert,
      tlsKey: tls.key
    })
    transports.push(second)

    await second.start()

    expect(second.resolvedPort).not.toBe(occupiedPort)
    expect(second.resolvedPort).toBeGreaterThan(0)

    const ws = await connectWs(second.resolvedPort)
    ws.close()
  })

  it('reaps a half-open client that stops responding to pings', async () => {
    // Why: regression cover for the half-open-socket leak that would
    // strand mobile clients in the connection pool until OS TCP keepalive
    // (~2 hours) reaped them. With the heartbeat, two consecutive ping
    // ticks without a pong should cause terminate() to fire and free the
    // slot. Verifying via the server's connection-close handler, which
    // is what frees up the MAX_WS_CONNECTIONS budget in production.
    const tls = makeTls()
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      tlsCert: tls.cert,
      tlsKey: tls.key,
      heartbeatIntervalMs: 50
    })
    transport.onMessage(() => {})
    transports.push(transport)

    let serverClosed = false
    transport.onConnectionClose(() => {
      serverClosed = true
    })

    // Why: setClientId is what registers the ws → clientId mapping that
    // onConnectionClose fires off. Hook the connection event before
    // start so we can stamp every accepted ws with a token.
    await transport.start()

    const ws = await connectWs(transport)
    // Why: pausing the underlying TCP socket halts both read (ping in)
    // and write (pong out) at the kernel level, so the `ws` library's
    // auto-pong can't actually be flushed back. From the server's
    // perspective the client looks half-open — exactly the production
    // failure mode iOS produces when it suspends a backgrounded socket.
    const underlying = (ws as unknown as { _socket: { pause: () => void } })._socket
    underlying.pause()

    // Why: we need a clientId on the ws so onConnectionClose actually
    // fires. The transport sets it lazily via setClientId in production
    // (after auth); in this test we don't run auth, so reach in.
    const wss = (transport as unknown as { wss: { clients: Set<{ readyState: number }> } }).wss
    for (const c of wss.clients) {
      transport.setClientId(c as never, 'test-client')
    }

    // Wait long enough for two heartbeat ticks (50ms each) plus slack.
    const start = Date.now()
    while (!serverClosed && Date.now() - start < 2_000) {
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(serverClosed).toBe(true)
    expect(wss.clients.size).toBe(0)
  }, 5_000)

  // Why: paired mobile devices store ws://ip:port endpoints, so the fallback
  // port must stay stable across restarts or pairings go permanently dead
  // when the preferred port is held by another instance (STA-1511).
  describe('fallback port stability', () => {
    async function reserveFreePort(): Promise<number> {
      const scratch = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
      await scratch.start()
      const port = scratch.resolvedPort
      await scratch.stop()
      return port
    }

    it('binds the persisted fallback port even when the preferred port is free', async () => {
      // Why: regression for the STA-1511 follow-up — devices paired while the
      // fallback port was active store ws://ip:<fallback>. A later launch that
      // finds the preferred port free must still bind the fallback, or those
      // pairings go permanently dead until the user re-pairs.
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
      // Why: issue #8535 — `orca serve --port <P>` clients dial the pin. A
      // free but stale mobile-ws-fallback-port.json must not pre-empt it.
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

    it('falls back when preferPinnedPort is set but the preferred port is taken', async () => {
      // Why: explicit pins still degrade to the STA-1511 fallback on
      // EADDRINUSE so previously-paired mobile devices remain reachable.
      const preferredHolder = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
      transports.push(preferredHolder)
      await preferredHolder.start()
      const preferredPort = preferredHolder.resolvedPort
      const fallbackPort = await reserveFreePort()

      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: preferredPort,
        fallbackPort,
        preferPinnedPort: true
      })
      transports.push(transport)
      await transport.start()
      expect(transport.resolvedPort).toBe(fallbackPort)
    })

    it('binds the preferred port when the persisted fallback is taken', async () => {
      const fallbackHolder = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
      transports.push(fallbackHolder)
      await fallbackHolder.start()
      const takenFallbackPort = fallbackHolder.resolvedPort
      const preferredPort = await reserveFreePort()

      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: preferredPort,
        fallbackPort: takenFallbackPort
      })
      transports.push(transport)
      await transport.start()
      expect(transport.resolvedPort).toBe(preferredPort)
    })

    it('falls through to the preferred port when the fallback bind fails with a non-EADDRINUSE error', async () => {
      // Why: a persisted fallback can land in an OS-reserved range on a later
      // launch (Windows Hyper-V excluded ports → EACCES). That must degrade to
      // the preferred port instead of disabling the transport for the session.
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

    it('still throws when the preferred port fails with a non-EADDRINUSE error', async () => {
      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: await reserveFreePort()
      })
      transports.push(transport)
      const withListen = transport as unknown as { tryListen(port: number): Promise<void> }
      withListen.tryListen = () =>
        Promise.reject(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }))

      await expect(transport.start()).rejects.toThrow('listen EACCES')
    })

    it('retries the persisted fallback port before an OS-assigned one', async () => {
      const holder = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
      transports.push(holder)
      await holder.start()
      const takenPort = holder.resolvedPort
      const fallbackPort = await reserveFreePort()

      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: takenPort,
        fallbackPort
      })
      transports.push(transport)
      await transport.start()
      expect(transport.resolvedPort).toBe(fallbackPort)
    })

    it('falls back to an OS-assigned port when the persisted port is also taken', async () => {
      const holder = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
      const fallbackHolder = new WebSocketTransport({ host: '127.0.0.1', port: 0 })
      transports.push(holder, fallbackHolder)
      await holder.start()
      await fallbackHolder.start()
      const takenPort = holder.resolvedPort
      const takenFallbackPort = fallbackHolder.resolvedPort

      const transport = new WebSocketTransport({
        host: '127.0.0.1',
        port: takenPort,
        fallbackPort: takenFallbackPort
      })
      transports.push(transport)
      await transport.start()
      expect(transport.resolvedPort).not.toBe(takenPort)
      expect(transport.resolvedPort).not.toBe(takenFallbackPort)
      expect(transport.resolvedPort).toBeGreaterThan(0)
    })
  })
})
