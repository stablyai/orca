import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as ServerWebSocket } from 'ws'
import { connect } from './rpc-client'
import { classifyConnection, verdictDisplayLabel } from './connection-health'

// Issue #10119 verification over a REAL socket, real timers, real WebSocket
// upgrade — guards the fake-timer suite in
// cellular-connecting-label-stall.test.ts against mock drift.
//
// The desktop is up and listening. The only thing wrong is that its E2EE
// handshake reply lands later than HANDSHAKE_TIMEOUT_MS (5s) — the condition a
// high-latency / lossy cellular link produces on a handshake that needs two
// round trips (e2ee_hello → e2ee_ready → e2ee_auth → e2ee_authenticated).
//
// The client must escalate past "Connecting…" and stay escalated. On the parent
// commit ws.onopen reset reconnectAttempt to 0 before the handshake succeeded,
// so getReconnectAttempt() never passed the connection-health gates and the
// label looped "Connecting…" forever.
//
// Opt-in like rpc-client-live-recovery.test.ts — needs ~22s wall-clock:
//   ORCA_MOBILE_LIVE_REPRO=1 pnpm vitest run src/transport/cellular-handshake-stall-real-socket.test.ts

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => plaintext,
  decrypt: (raw: string) => raw,
  decryptBytes: (bytes: Uint8Array) => bytes
}))

const RUN_LIVE =
  process.env.ORCA_MOBILE_LIVE_REPRO === '1' || !!process.env.ORCA_MOBILE_LIVE_REPRO_FULL

// Long enough for three handshake-timeout cycles (≈17s) plus CI scheduling slack.
const OBSERVE_MS = 22_000
const SAMPLE_MS = 200

let server: WebSocketServer | null = null
const serverSockets: ServerWebSocket[] = []

// Completes the WebSocket upgrade, then answers e2ee_hello later than the
// client's 5s handshake budget allows.
async function startSlowHandshakeDesktop(replyAfterMs: number): Promise<number> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server = wss
  wss.on('connection', (socket) => {
    serverSockets.push(socket)
    socket.on('message', (data) => {
      const text = data.toString()
      if (!text.includes('e2ee_hello')) {
        return
      }
      setTimeout(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'e2ee_ready', publicKeyB64: 'server-public-key' }))
        }
      }, replyAfterMs)
    })
  })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (typeof address === 'string' || address === null) {
    throw new Error('expected a TCP address')
  }
  return address.port
}

describe.runIf(RUN_LIVE)('issue #10119 — real socket, handshake slower than the 5s budget', () => {
  beforeEach(() => {
    serverSockets.length = 0
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const socket of serverSockets) {
      socket.terminate()
    }
    const wss = server
    server = null
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  it('escalates and latches against a live desktop that answers 1s too late', async () => {
    const port = await startSlowHandshakeDesktop(6_000)
    const endpoint = `ws://127.0.0.1:${port}`
    const client = connect(endpoint, 'device-token', 'server-public-key')

    const labels: string[] = []
    const states: string[] = []
    let maxAttempts = 0
    const started = Date.now()
    while (Date.now() - started < OBSERVE_MS) {
      const state = client.getState()
      const attempts = client.getReconnectAttempt()
      maxAttempts = Math.max(maxAttempts, attempts)
      states.push(state)
      labels.push(
        verdictDisplayLabel(
          classifyConnection({
            state,
            reconnectAttempts: attempts,
            lastConnectedAt: client.getLastConnectedAt(),
            endpoint
          })
        )
      )
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS))
    }
    client.close()

    // The dial loop really did run and really did keep failing.
    expect(serverSockets.length).toBeGreaterThanOrEqual(2)
    expect(states).toContain('handshaking')
    expect(states).not.toContain('connected')

    // The failure counter survives ws.onopen, so the warning gate (>= 3) fires.
    expect(maxAttempts).toBeGreaterThanOrEqual(3)
    const firstEscalated = labels.findIndex((l) => l !== 'Connecting…' && l !== 'Reconnecting…')
    expect(firstEscalated).toBeGreaterThan(0)

    // Once escalated, later redials never revert the label to "Connecting…".
    expect(labels.slice(firstEscalated).every((l) => l !== 'Connecting…')).toBe(true)
  }, 60_000)
})

// Why: vitest fails a file with zero tests; keep a sentinel for default runs.
describe.runIf(!RUN_LIVE)('real-socket handshake stall (skipped)', () => {
  it('is opt-in via ORCA_MOBILE_LIVE_REPRO=1', () => {
    expect(true).toBe(true)
  })
})
