#!/usr/bin/env npx tsx
// Why: standalone mock WebSocket server for developing the mobile app without
// a running Orca desktop instance. Responds to the same RPC methods the real
// runtime exposes, with realistic fake data. Supports E2EE handshake.
import { WebSocketServer, type WebSocket } from 'ws'
import nacl from 'tweetnacl'

const PORT = Number(process.env.PORT) || 6768
const AUTH_TOKEN = 'mock-device-token'

// Why: generate a persistent server keypair for this mock session.
// The public key is printed at startup so it can be used in pairing QR data.
const serverKeyPair = nacl.box.keyPair()
const serverPublicKeyB64 = Buffer.from(serverKeyPair.publicKey).toString('base64')

type E2EEState = {
  sharedKey: Uint8Array
  deviceToken: string | null
  authenticated: boolean
}

function deriveSharedKey(ourSecret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublic, ourSecret)
}

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
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) return null
  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const ciphertext = bundle.slice(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)
  if (!plaintext) return null
  return new TextDecoder().decode(plaintext)
}

const FAKE_WORKTREES = [
  {
    worktreeId: 'repo-1::/home/user/projects/acme-api',
    repoId: 'repo-1',
    repo: 'acme-api',
    path: '/home/user/projects/acme-api',
    branch: 'feature/auth-refactor',
    linkedIssue: 42,
    unread: true,
    liveTerminalCount: 2,
    hasAttachedPty: true,
    lastOutputAt: Date.now() - 5000,
    preview: '$ claude "refactor the auth module"'
  },
  {
    worktreeId: 'repo-1::/home/user/projects/acme-web',
    repoId: 'repo-1',
    repo: 'acme-web',
    path: '/home/user/projects/acme-web',
    branch: 'main',
    linkedIssue: null,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    lastOutputAt: Date.now() - 60000,
    preview: '$ npm test\nAll tests passed.'
  }
]

const FAKE_TERMINALS = [
  {
    handle: 'term-1',
    worktreeId: 'repo-1::/home/user/projects/acme-api',
    title: 'Claude — auth refactor',
    isActive: true,
    hasRunningProcess: true
  },
  {
    handle: 'term-2',
    worktreeId: 'repo-1::/home/user/projects/acme-api',
    title: 'zsh',
    isActive: false,
    hasRunningProcess: false
  }
]

const FAKE_SCROLLBACK = [
  '$ claude "refactor the auth module to use JWT tokens"',
  '',
  '⏳ Working on it...',
  '',
  "I'll refactor the auth module. Here's my plan:",
  '1. Replace session-based auth with JWT',
  '2. Add token refresh endpoint',
  '3. Update middleware',
  '',
  'Let me start by reading the current auth module...',
  ''
].join('\n')

const STREAMING_CHUNKS = [
  'Reading src/auth/middleware.ts...\n',
  'Reading src/auth/session.ts...\n',
  '\nI see the current implementation uses express-session.\n',
  "I'll replace it with jsonwebtoken.\n",
  '\nUpdating src/auth/middleware.ts...\n'
]

type RpcRequest = {
  id: string
  method: string
  deviceToken?: string
  params?: Record<string, unknown>
}

type RpcResponse = {
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
  streaming?: true
  _meta: { runtimeId: string }
}

function success(id: string, result: unknown, streaming?: boolean): RpcResponse {
  const resp: RpcResponse = { id, ok: true, result, _meta: { runtimeId: 'mock-runtime' } }
  if (streaming) {
    resp.streaming = true
  }
  return resp
}

function error(id: string, code: string, message: string): RpcResponse {
  return { id, ok: false, error: { code, message }, _meta: { runtimeId: 'mock-runtime' } }
}

function handleRequest(
  request: RpcRequest,
  send: (response: RpcResponse) => void,
  ws: WebSocket
): void {
  switch (request.method) {
    case 'status.get':
      send(
        success(request.id, {
          runtimeId: 'mock-runtime',
          graphStatus: 'ready',
          windowCount: 1,
          tabCount: 2,
          terminalCount: 2
        })
      )
      break

    case 'worktree.ps':
      send(
        success(request.id, {
          worktrees: FAKE_WORKTREES,
          totalCount: FAKE_WORKTREES.length,
          truncated: false
        })
      )
      break

    case 'terminal.list':
      send(
        success(request.id, {
          terminals: FAKE_TERMINALS,
          totalCount: FAKE_TERMINALS.length,
          truncated: false
        })
      )
      break

    case 'terminal.subscribe': {
      send(success(request.id, { type: 'scrollback', lines: FAKE_SCROLLBACK, truncated: false }))

      let chunkIndex = 0
      const interval = setInterval(() => {
        if (chunkIndex >= STREAMING_CHUNKS.length || ws.readyState !== ws.OPEN) {
          clearInterval(interval)
          if (ws.readyState === ws.OPEN) {
            send(success(request.id, { type: 'end' }))
          }
          return
        }
        send(success(request.id, { type: 'data', chunk: STREAMING_CHUNKS[chunkIndex] }, true))
        chunkIndex++
      }, 500)
      break
    }

    case 'terminal.send':
      send(success(request.id, { send: { handle: 'term-1', ok: true } }))
      break

    case 'terminal.unsubscribe':
      send(success(request.id, { unsubscribed: true }))
      break

    default:
      send(error(request.id, 'method_not_found', `Unknown method: ${request.method}`))
  }
}

const wss = new WebSocketServer({ port: PORT })

// Why: each connection goes through an E2EE handshake before any RPC traffic.
// The first message must be e2ee_hello (plaintext), then all subsequent
// messages are encrypted with the derived shared key.
const connectionState = new Map<WebSocket, E2EEState>()

wss.on('connection', (ws) => {
  console.log('[mock] Client connected — waiting for e2ee_hello')

  ws.on('message', (data) => {
    const msg = typeof data === 'string' ? data : data.toString('utf-8')
    const e2ee = connectionState.get(ws)

    if (!e2ee) {
      // Handshake phase — expect e2ee_hello
      let hello: { type?: string; publicKeyB64?: string }
      try {
        hello = JSON.parse(msg)
      } catch {
        ws.send(JSON.stringify({ type: 'e2ee_error', message: 'Invalid JSON' }))
        ws.close()
        return
      }

      if (hello.type !== 'e2ee_hello' || !hello.publicKeyB64) {
        ws.send(JSON.stringify({ type: 'e2ee_error', message: 'Expected e2ee_hello' }))
        ws.close()
        return
      }

      const clientPublicKey = Uint8Array.from(Buffer.from(hello.publicKeyB64, 'base64'))
      if (clientPublicKey.length !== 32) {
        ws.send(JSON.stringify({ type: 'e2ee_error', message: 'Invalid public key' }))
        ws.close()
        return
      }

      const sharedKey = deriveSharedKey(serverKeyPair.secretKey, clientPublicKey)
      connectionState.set(ws, { sharedKey, deviceToken: null, authenticated: false })

      ws.send(JSON.stringify({ type: 'e2ee_ready' }))
      console.log('[mock] E2EE key exchange complete — waiting for encrypted auth')
      return
    }

    // Post-handshake — decrypt, handle, encrypt reply
    const plaintext = e2eeDecrypt(msg, e2ee.sharedKey)
    if (plaintext === null) {
      console.log('[mock] Decryption failed — dropping message')
      return
    }

    let request: RpcRequest
    try {
      request = JSON.parse(plaintext) as RpcRequest
    } catch {
      const encrypted = e2eeEncrypt(
        JSON.stringify(error('unknown', 'bad_request', 'Invalid JSON')),
        e2ee.sharedKey
      )
      ws.send(encrypted)
      return
    }

    if (!e2ee.authenticated) {
      const auth = request as unknown as { type?: string; deviceToken?: string }
      if (auth.type !== 'e2ee_auth' || auth.deviceToken !== AUTH_TOKEN) {
        ws.send(
          e2eeEncrypt(
            JSON.stringify({ type: 'e2ee_error', error: { code: 'unauthorized' } }),
            e2ee.sharedKey
          )
        )
        ws.close()
        return
      }
      e2ee.deviceToken = auth.deviceToken
      e2ee.authenticated = true
      ws.send(e2eeEncrypt(JSON.stringify({ type: 'e2ee_authenticated' }), e2ee.sharedKey))
      console.log('[mock] E2EE authentication complete')
      return
    }

    console.log(`[mock] ${request.method} (id: ${request.id})`)
    handleRequest(
      request,
      (response) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(e2eeEncrypt(JSON.stringify(response), e2ee.sharedKey))
        }
      },
      ws
    )
  })

  ws.on('close', () => {
    connectionState.delete(ws)
    console.log('[mock] Client disconnected')
  })

  ws.on('error', () => {
    connectionState.delete(ws)
    ws.close()
  })
})

console.log(`[mock] Orca mock server listening on ws://localhost:${PORT}`)
console.log(`[mock] Auth token: ${AUTH_TOKEN}`)
console.log(`[mock] Server public key (base64): ${serverPublicKeyB64}`)
console.log(`[mock] E2EE enabled — clients must send e2ee_hello before RPC`)
