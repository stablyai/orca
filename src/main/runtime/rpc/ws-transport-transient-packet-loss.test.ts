// Real loopback peers must survive one swallowed pong, as with transient cellular/Tailscale loss (STA-3320).
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'

const PROBE_INTERVAL_MS = 150

// Advance now once per sweep to eliminate scheduler jitter from suspend detection; assertions count probes, not wall time.
function createStepClock(stepMs: number): () => number {
  let calls = 0
  return () => 1_000_000 + calls++ * stepMs
}

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
  })

  async function startTransport(): Promise<WebSocketTransport> {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: PROBE_INTERVAL_MS,
      heartbeatNow: createStepClock(PROBE_INTERVAL_MS),
      // Keep pre-auth expiry outside this liveness test.
      preAuthTimeoutMs: 600_000
    })
    transports.push(transport)
    await transport.start()
    return transport
  }

  it('keeps a live client whose pong is swallowed for a single probe', async () => {
    const transport = await startTransport()
    // Disable autoPong to drop exactly one protocol reply.
    const client = new WebSocket(`ws://127.0.0.1:${transport.resolvedPort}`, { autoPong: false })
    sockets.push(client)

    let probesReceived = 0
    const pongedProbes: number[] = []
    const swallowedProbe = 2
    let closed = false
    client.on('ping', () => {
      probesReceived += 1
      if (probesReceived === swallowedProbe) {
        return
      }
      pongedProbes.push(probesReceived)
      client.pong()
    })
    client.on('close', () => {
      closed = true
    })
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    // Mark the synthetic peer authenticated so production heartbeat runs instead of pre-auth expiry.
    const wss = (transport as unknown as { wss: { clients: Set<WebSocket> } }).wss
    for (const serverSocket of wss.clients) {
      transport.setClientId(serverSocket, 'test-client')
    }

    // Bounded by counted probe events, never by elapsed time.
    await vi.waitFor(() => expect(closed || probesReceived >= swallowedProbe + 2).toBe(true), {
      timeout: 15_000,
      interval: 10
    })

    expect({ closed, probesReceived }).toEqual({ closed: false, probesReceived: 4 })
    // The peer was demonstrably alive across the blackhole: it answered the probes on both sides of it.
    expect(pongedProbes).toEqual([1, 3, 4])
    expect(client.readyState).toBe(WebSocket.OPEN)
  })
})
