import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as ServerWebSocket } from 'ws'
import { connect } from './rpc-client'
import { classifyConnection, verdictDisplayLabel } from './connection-health'

// Guard fake-timer mock drift with real WebSocket upgrades and delayed E2EE replies (#10119).
// Opt in with ORCA_MOBILE_LIVE_REPRO=1; this needs real timers and roughly 22 seconds.

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

// Allow three handshake timeout cycles plus CI scheduling slack.
const OBSERVE_MS = 22_000
const SAMPLE_MS = 200

let server: WebSocketServer | null = null
const serverSockets: ServerWebSocket[] = []

// Upgrade succeeds but e2ee_ready arrives after the handshake budget.
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

    expect(serverSockets.length).toBeGreaterThanOrEqual(2)
    expect(states).toContain('handshaking')
    expect(states).not.toContain('connected')

    expect(maxAttempts).toBeGreaterThanOrEqual(3)
    const firstEscalated = labels.findIndex((l) => l !== 'Connecting…' && l !== 'Reconnecting…')
    expect(firstEscalated).toBeGreaterThan(0)

    expect(labels.slice(firstEscalated).every((l) => l !== 'Connecting…')).toBe(true)
  }, 60_000)
})
