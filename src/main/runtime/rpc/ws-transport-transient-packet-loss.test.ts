// Real ws server + real ws client over loopback: a live, well-behaved peer whose pong is swallowed by
// a transient blackhole must not be terminated (STA-3320).
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'

const PROBE_INTERVAL_MS = 150

// Why: the heartbeat calls now() exactly once per sweep, so a per-call step makes elapsed exactly one
// interval every sweep — real scheduler jitter can never be mistaken for a suspended loop, and no
// assertion in this file depends on wall time.
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
      // Why: this test is about liveness, not the auth handshake; keep the pre-auth reaper out of it.
      preAuthTimeoutMs: 600_000
    })
    transports.push(transport)
    await transport.start()
    return transport
  }

  it('keeps a live client whose pong is swallowed for a single probe', async () => {
    const transport = await startTransport()
    // autoPong:false hands us the protocol-level pong so we can drop exactly one, the way a
    // cellular/Tailscale blackhole drops exactly the frames in flight during the stall.
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
