#!/usr/bin/env npx tsx
// Why: standalone mock WebSocket server for developing the mobile app without
// a running Orca desktop instance. Responds to the same RPC methods the real
// runtime exposes, with realistic fake data. Supports E2EE handshake.
import { WebSocketServer, type WebSocket } from 'ws'
import nacl from 'tweetnacl'
import { deriveSharedKey, e2eeDecrypt, e2eeEncrypt, type E2EEState } from './mock-server-encryption'
import {
  error,
  handleRequest,
  mockScenarioSummary,
  type RpcRequest
} from './mock-server-rpc-handlers'

const PORT = Number(process.env.PORT) || 6768
const AUTH_TOKEN = 'mock-device-token'

// Why: generate a persistent server keypair for this mock session.
// The public key is printed at startup so it can be used in pairing QR data.
const serverKeyPair = nacl.box.keyPair()
const serverPublicKeyB64 = Buffer.from(serverKeyPair.publicKey).toString('base64')

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
console.log(
  `[mock] Scenario: ${mockScenarioSummary.repoCount} repos, ${mockScenarioSummary.worktreeCount} worktrees, ${mockScenarioSummary.rpcDelayMs}ms default RPC delay`
)
console.log(`[mock] E2EE enabled — clients must send e2ee_hello before RPC`)
