#!/usr/bin/env node
/**
 * In-container smoke test for the headless @stablyai/orca-server bundle.
 *
 * Boots the bundled server as a child process, reads the JSON pairing payload
 * from its stdout, then connects over WebSocket and performs the real E2EE
 * handshake (e2ee_hello -> e2ee_auth) before issuing an encrypted `host.platform`
 * RPC. Success proves the whole headless path works under plain Node:
 * RPC transport binds, pairing mints a usable token, the E2EE channel completes,
 * and the dispatcher answers — with no Electron and no display.
 *
 * Pure deps: ws + tweetnacl (both already in the server's dependency closure).
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import nacl from 'tweetnacl'

const SERVER_ENTRY = process.argv[2] || '/app/orca-ide.js'
const SERVER_ARGS = SERVER_ENTRY.endsWith('orca-server.js')
  ? [SERVER_ENTRY, '--serve-port', '0', '--json']
  : [SERVER_ENTRY, 'serve', '--port', '0', '--json']
const EXPECTED_PLATFORM = process.env.ORCA_SMOKE_EXPECTED_PLATFORM || process.platform
const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`)
  process.exit(1)
}

function b64(u8) {
  return Buffer.from(u8).toString('base64')
}
function fromB64(s) {
  return Uint8Array.from(Buffer.from(s, 'base64'))
}
function encrypt(plaintext, sharedKey) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ct = nacl.box.after(Buffer.from(plaintext, 'utf8'), nonce, sharedKey)
  const bundle = new Uint8Array(nonce.length + ct.length)
  bundle.set(nonce)
  bundle.set(ct, nonce.length)
  return b64(bundle)
}
function decrypt(encoded, sharedKey) {
  const bundle = fromB64(encoded)
  const nonce = bundle.slice(0, nacl.box.nonceLength)
  const ct = bundle.slice(nacl.box.nonceLength)
  const pt = nacl.box.open.after(ct, nonce, sharedKey)
  return pt ? Buffer.from(pt).toString('utf8') : null
}

const child = spawn('node', SERVER_ARGS, {
  env: { ...process.env, ORCA_USER_DATA_PATH: '/tmp/orca-smoke-data' },
  stdio: ['ignore', 'pipe', 'inherit']
})

let stdout = ''
const startTimeout = setTimeout(() => fail('server did not print ready payload within 20s'), 20_000)

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
  const lines = stdout.split('\n')
  stdout = lines.pop() ?? ''
  const line = lines.find((l) => l.includes('orca_server_ready'))
  if (!line) {
    return
  }
  clearTimeout(startTimeout)
  let ready
  try {
    ready = JSON.parse(line.trim())
  } catch (e) {
    return fail(`could not parse ready payload: ${e.message}`)
  }
  if (!ready.pairing || !ready.pairing.url) {
    return fail('no pairing URL minted')
  }
  console.log(`[smoke] server ready, endpoint=${ready.endpoint}`)
  void runClient(ready)
})

child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    fail(`server exited early with code ${code}`)
  }
})

async function runClient(ready) {
  // Decode the pairing code: base64url JSON {endpoint, deviceToken, publicKeyB64}
  const code = new URL(ready.pairing.url).searchParams.get('code')
  const pairing = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
  const wsUrl = pairing.endpoint
  console.log(`[smoke] connecting ${wsUrl} ...`)

  const keyPair = nacl.box.keyPair()
  const sharedKey = nacl.box.before(fromB64(pairing.publicKeyB64), keyPair.secretKey)
  const ws = new WebSocket(wsUrl)
  let phase = 'hello' // hello -> auth -> rpc -> done
  const RPC_METHOD = 'host.platform'
  const RPC_ID = '1'

  const callTimeout = setTimeout(
    () => fail(`handshake/RPC stalled in phase=${phase} within 15s`),
    15_000
  )

  ws.on('open', () => {
    // Protocol: plaintext e2ee_hello -> server plaintext e2ee_ready ->
    // ENCRYPTED e2ee_auth -> server ENCRYPTED e2ee_authenticated -> encrypted RPC.
    ws.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: b64(keyPair.publicKey) }))
  })

  ws.on('message', (data) => {
    const text = data.toString()
    // Pre-ready frames are plaintext JSON; post-key frames are encrypted base64.
    let msg
    if (text.startsWith('{')) {
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
    } else {
      const dec = decrypt(text, sharedKey)
      if (dec === null) {
        return
      }
      try {
        msg = JSON.parse(dec)
      } catch {
        return
      }
    }
    if (msg._keepalive) {
      return
    }

    if (phase === 'hello' && msg.type === 'e2ee_ready') {
      phase = 'auth'
      // e2ee_auth must be ENCRYPTED (server decrypts before handleAuth).
      ws.send(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }), sharedKey)
      )
      return
    }
    if (phase === 'auth' && msg.type === 'e2ee_authenticated') {
      phase = 'rpc'
      ws.send(encrypt(JSON.stringify({ id: RPC_ID, method: RPC_METHOD, params: null }), sharedKey))
      return
    }
    if (phase === 'rpc' && msg.id === RPC_ID) {
      clearTimeout(callTimeout)
      phase = 'done'
      if (msg.error) {
        return fail(`RPC ${RPC_METHOD} returned error: ${JSON.stringify(msg.error)}`)
      }
      console.log(`[smoke] RPC ${RPC_METHOD} result: ${JSON.stringify(msg.result)}`)
      if (!msg.result || msg.result.platform !== EXPECTED_PLATFORM) {
        return fail(`expected platform=${EXPECTED_PLATFORM}, got ${JSON.stringify(msg.result)}`)
      }
      console.log(
        'SMOKE PASS: headless server booted, paired, E2EE handshake + encrypted RPC succeeded on Node with no Electron.'
      )
      ws.close()
      child.kill('SIGTERM')
      process.exit(0)
    }
  })

  ws.on('error', (err) => fail(`websocket error: ${err.message}`))
}
