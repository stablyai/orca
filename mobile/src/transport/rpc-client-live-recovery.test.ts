// Exercise legacy framing with real sockets, timers and NaCl against half-open mobile/Tailscale paths (#5049).
// ORCA_MOBILE_LIVE_REPRO=1 enables the short case; ORCA_MOBILE_LIVE_REPRO_FULL=1 adds the roughly eight-minute recovery loop.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { connect, type RpcClient } from './rpc-client'

// Use Node secure randomness in place of Expo; keep production crypto/framing for the harness.
vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(randomBytes(n))
}))

vi.mock('./direct-e2ee-framing-policy', () => import('./legacy-direct-framing-test-policy'))

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

// Use an OS-assigned initial port, then reuse it because the client retains its reconnect URL.
function startServer(port = 0): Promise<WebSocketServer> {
  // host must match the 127.0.0.1 clients dial: a wildcard bind lets a foreign loopback listener claim the port and answer here.
  const wss = new WebSocketServer({ host: '127.0.0.1', port })
  wss.on('connection', (ws: ServerSocket) => {
    let sharedKey: Uint8Array | null = null
    let authenticated = false
    ws.on('message', (data) => {
      if (blackhole) {
        return
      }
      const msg = typeof data === 'string' ? data : data.toString('utf-8')
      if (!sharedKey) {
        const hello: unknown = JSON.parse(msg)
        if (
          !hello ||
          typeof hello !== 'object' ||
          !('publicKeyB64' in hello) ||
          typeof hello.publicKeyB64 !== 'string'
        ) {
          ws.terminate()
          return
        }
        const clientKey = Uint8Array.from(Buffer.from(hello.publicKeyB64, 'base64'))
        sharedKey = nacl.box.before(clientKey, serverKeyPair.secretKey)
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const plaintext = e2eeDecrypt(msg, sharedKey)
      if (!plaintext) {
        return
      }
      const request: unknown = JSON.parse(plaintext)
      if (!request || typeof request !== 'object') {
        return
      }
      if (!authenticated) {
        if (
          'type' in request &&
          request.type === 'e2ee_auth' &&
          'deviceToken' in request &&
          request.deviceToken === AUTH_TOKEN
        ) {
          authenticated = true
          ws.send(e2eeEncrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
        }
        return
      }
      if (!('id' in request) || typeof request.id !== 'string') {
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
  const address = wss.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected an assigned loopback port')
  }
  return address.port
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

  it.each(['focus', 'app-resume', 'network-change'] as const)(
    'reaps a half-open link via %s and recovers',
    { timeout: 60_000 },
    async (reason) => {
      wss = await startServer()
      client = connect(`ws://127.0.0.1:${serverPort(wss)}`, AUTH_TOKEN, serverPublicKeyB64)
      const c = client
      await waitFor('initial connect', 10_000, () => c.getState() === 'connected')
      expect((await c.sendRequest('status.get')).ok).toBe(true)

      // Half-open: server keeps TCP up but stops answering, then the app
      // comes back to the foreground.
      blackhole = true
      c.notifyForeground(reason)
      const detectMs = await waitFor(
        'half-open detected',
        32_000,
        () => c.getState() !== 'connected'
      )
      console.log('[direct-revival-capture]', { reason, detectMs })
      expect(detectMs).toBeLessThan(reason === 'focus' ? 30_000 : 6_000)

      blackhole = false
      await waitFor('recovered after link healed', 15_000, () => c.getState() === 'connected')
      expect((await c.sendRequest('status.get')).ok).toBe(true)
    }
  )

  it.runIf(RUN_FULL)(
    'foreground nudge accelerates recovery while the trickle retry is pending',
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
      // Wait for the final scheduled retry to fire while the server is still down, beyond the count reaching its cap.
      await sleep(65_000)
      expect(c.getState()).toBe('reconnecting')

      wss = await startServer(port)
      // The next 90-second trickle retry is still pending during this observation.
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
