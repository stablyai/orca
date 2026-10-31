import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'

const PROBE_INTERVAL_MS = 150

describe('WebSocketTransport under transient packet loss', () => {
  const transports: WebSocketTransport[] = []
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets) {
      socket.removeAllListeners()
      socket.terminate()
    }
    sockets.length = 0
    await Promise.all(transports.map((t) => t.stop().catch(() => {})))
    transports.length = 0
    vi.useRealTimers()
  })

  async function startTransport(now: () => number): Promise<WebSocketTransport> {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: PROBE_INTERVAL_MS,
      heartbeatNow: now,
      // Keep pre-auth expiry outside this liveness test.
      preAuthTimeoutMs: 600_000
    })
    transports.push(transport)
    await transport.start()
    return transport
  }

  it('keeps a live client whose pong is swallowed for a single probe', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let now = 1_000_000
    const transport = await startTransport(() => now)
    const accepted = new Promise<WebSocket>((resolve) => {
      transport.onMessage((_message, _reply, ws) => {
        transport.setClientId(ws, 'test-client')
        resolve(ws)
      })
    })
    // Disable autoPong to drop exactly one protocol reply.
    const client = new WebSocket(`ws://127.0.0.1:${transport.resolvedPort}`, { autoPong: false })
    sockets.push(client)

    let probesReceived = 0
    const pongedProbes: number[] = []
    const swallowedProbe = 2
    const closed = new Promise<'closed'>((resolve) => {
      client.once('close', () => resolve('closed'))
    })
    client.on('ping', () => {
      probesReceived += 1
      if (probesReceived === swallowedProbe) {
        return
      }
      pongedProbes.push(probesReceived)
      client.pong()
    })
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    client.send('test-peer')
    const server = await accepted

    for (let probe = 1; probe <= swallowedProbe + 2; probe += 1) {
      const ping = new Promise<'ping'>((resolve) => client.once('ping', () => resolve('ping')))
      const pong =
        probe === swallowedProbe
          ? undefined
          : new Promise<void>((resolve) => server.once('pong', () => resolve()))
      now += PROBE_INTERVAL_MS
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
      expect(await Promise.race([ping, closed])).toBe('ping')
      await pong
    }

    expect(probesReceived).toBe(4)
    expect(pongedProbes).toEqual([1, 3, 4])
    expect(client.readyState).toBe(WebSocket.OPEN)
  })
})
