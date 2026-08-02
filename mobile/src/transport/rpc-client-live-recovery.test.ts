// Live (real-socket, real-timer) repro harness for issue #5049: Android
// remote sessions that appear connected but stop responding until the app
// is reopened. Unlike rpc-client.test.ts (fake timers, mocked e2ee), this
// runs the REAL rpc-client with real tweetnacl E2EE against an in-process
// ws server, simulating the Tailscale failure modes behind the report.
//
// Opt-in because the quick scenario takes ~15s wall-clock and the full
// parked-loop scenario ~8 minutes:
//   ORCA_MOBILE_LIVE_REPRO=1 pnpm vitest run src/transport/rpc-client-live-recovery.test.ts
//   ORCA_MOBILE_LIVE_REPRO_FULL=1 ... (adds the 8-minute parked-loop case)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { connect, type RpcClient } from './rpc-client'

// Why: expo-crypto only exists inside a React Native runtime; Node's CSPRNG
// is equivalent for the harness. Everything else (tweetnacl, the wire
// protocol) is the real production path.
vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(randomBytes(n))
}))

const RUN_LIVE =
  process.env.ORCA_MOBILE_LIVE_REPRO === '1' || !!process.env.ORCA_MOBILE_LIVE_REPRO_FULL
const RUN_FULL = process.env.ORCA_MOBILE_LIVE_REPRO_FULL === '1'

const AUTH_TOKEN = 'repro-device-token'

const serverKeyPair = nacl.box.keyPair()
const serverPublicKeyB64 = Buffer.from(serverKeyPair.publicKey).toString('base64')

// When true the server accepts traffic but never replies — simulates a
// half-open link where TCP looks alive but the path is dead.
let blackhole = false

function e2eeEncrypt(plaintext: string, sharedKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const msg = new TextEncoder().encode(plaintext)
  const ciphertext = nacl.box.after(msg, nonce, sharedKey)
  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)
  return Buffer.from(bundle).toString('base64')
}

function e2eeDecrypt(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = Uint8Array.from(Buffer.from(encrypted, 'base64'))
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }
  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(bundle.slice(nacl.box.nonceLength), nonce, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

// Why: port 0 lets the OS assign a free port so the opt-in harness can't
// fail with EADDRINUSE; the full scenario restarts on the captured port
// because the client keeps reconnecting to its original URL.
function startServer(port = 0): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ port })
  wss.on('connection', (ws: ServerSocket) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false
    ws.on('message', (data) => {
      if (blackhole) {
        return
      }
      const msg = typeof data === 'string' ? data : data.toString('utf-8')
      if (!sharedKey) {
        const hello = JSON.parse(msg) as { publicKeyB64: string }
        const clientKey = Uint8Array.from(Buffer.from(hello.publicKeyB64, 'base64'))
        sharedKey = nacl.box.before(clientKey, serverKeyPair.secretKey)
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const plaintext = e2eeDecrypt(msg, sharedKey)
      if (!plaintext) {
        return
      }
      const request = JSON.parse(plaintext) as { id?: string; type?: string; deviceToken?: string }
      if (!authenticated) {
        if (request.type === 'e2ee_auth' && request.deviceToken === AUTH_TOKEN) {
          authenticated = true
          ws.send(e2eeEncrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
        }
        return
      }
      ws.send(
        e2eeEncrypt(JSON.stringify({ id: request.id, ok: true, result: { up: true } }), sharedKey)
      )
    })
  })
  return new Promise((resolve) => wss.once('listening', () => resolve(wss)))
}

function serverPort(wss: WebSocketServer): number {
  return (wss.address() as AddressInfo).port
}

function stopServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    for (const ws of wss.clients) {
      ws.terminate()
    }
    wss.close(() => resolve())
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return Date.now() - start
    }
    await sleep(200)
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for: ${label}`)
}

describe.runIf(RUN_LIVE)('live foreground recovery (issue #5049)', () => {
  let client: RpcClient | null = null
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    blackhole = false
    client?.close()
    client = null
    if (wss) {
      await stopServer(wss)
      wss = null
    }
  })

  it(
    'reaps a half-open link via the foreground probe and recovers',
    { timeout: 60_000 },
    async () => {
      wss = await startServer()
      client = connect(`ws://127.0.0.1:${serverPort(wss)}`, AUTH_TOKEN, serverPublicKeyB64)
      const c = client
      await waitFor('initial connect', 10_000, () => c.getState() === 'connected')
      expect((await c.sendRequest('status.get')).ok).toBe(true)

      // Half-open: server keeps TCP up but stops answering, then the app
      // comes back to the foreground.
      blackhole = true
      c.notifyForeground()
      // Foreground probe budget is 8s; the interval probe alone would take
      // up to 28s. Allow scheduling slack but stay well under 28s.
      const detectMs = await waitFor(
        'half-open detected',
        15_000,
        () => c.getState() !== 'connected'
      )
      expect(detectMs).toBeLessThan(12_000)

      blackhole = false
      await waitFor('recovered after link healed', 15_000, () => c.getState() === 'connected')
      expect((await c.sendRequest('status.get')).ok).toBe(true)
    }
  )

  it.runIf(RUN_FULL)(
    'repro: parked retry loop stays stuck until the foreground nudge',
    { timeout: 600_000 },
    async () => {
      wss = await startServer()
      const port = serverPort(wss)
      client = connect(`ws://127.0.0.1:${port}`, AUTH_TOKEN, serverPublicKeyB64)
      const c = client
      await waitFor('initial connect', 10_000, () => c.getState() === 'connected')

      await stopServer(wss)
      wss = null
      await waitFor('retry cap scheduled (~5 min)', 480_000, () => c.getReconnectAttempt() >= 12)
      // The attempt counter hits 12 when the final attempt is *scheduled*;
      // its 60s backoff timer is still pending. Let it fire and fail while
      // the server is still down so the loop truly parks.
      await sleep(65_000)
      expect(c.getState()).toBe('reconnecting')

      wss = await startServer(port)
      // Pre-fix behavior: even with the server back, a parked loop never
      // recovers — the user had to restart the app.
      await sleep(70_000)
      expect(c.getState()).not.toBe('connected')

      c.notifyForeground()
      await waitFor('foreground nudge recovered the session', 15_000, () => {
        return c.getState() === 'connected'
      })
      expect((await c.sendRequest('status.get')).ok).toBe(true)
    }
  )
})

// Why: vitest fails a file with zero tests; keep a sentinel for default runs.
describe.runIf(!RUN_LIVE)('live foreground recovery (skipped)', () => {
  it('is opt-in via ORCA_MOBILE_LIVE_REPRO=1', () => {
    expect(true).toBe(true)
  })
})
