import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, afterEach } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'
import { loadOrCreateTlsCertificate } from '../tls-certificate'

// Why: disable TLS verification for self-signed certs in tests.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

function makeTls() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'ws-transport-test-'))
  return loadOrCreateTlsCertificate(userDataPath)
}

describe('WebSocketTransport', () => {
  const transports: WebSocketTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop().catch(() => {})))
    transports.length = 0
  })

  async function createTransport(
    handler?: (msg: string, reply: (response: string) => void) => void
  ) {
    const tls = makeTls()
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      // Why: random "free" ports can still collide before listen() binds.
      // Port 0 lets the OS reserve an available port atomically.
      port: 0,
      tlsCert: tls.cert,
      tlsKey: tls.key
    })
    if (handler) {
      transport.onMessage(handler)
    }
    transports.push(transport)
    return { transport, tls }
  }

  function connectWs(port: number): Promise<WebSocket> {
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

  it('handles request/response round-trip', async () => {
    const { transport } = await createTransport((msg, reply) => {
      const request = JSON.parse(msg)
      reply(JSON.stringify({ id: request.id, ok: true, result: { echo: true } }))
    })

    await transport.start()

    const ws = await connectWs(transport.resolvedPort)
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
      connectWs(transport.resolvedPort),
      connectWs(transport.resolvedPort),
      connectWs(transport.resolvedPort)
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

    const ws = await connectWs(transport.resolvedPort)

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

    const ws = await connectWs(transport.resolvedPort)
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

    const ws = await connectWs(transport.resolvedPort)

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

    const ws = await connectWs(transport.resolvedPort)
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

    const ws = await connectWs(transport.resolvedPort)
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
})
