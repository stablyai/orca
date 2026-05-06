/**
 * Lightweight terminal streaming repro for the mobile WebSocket RPC.
 *
 * Usage:
 *   pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64> [worktreeSelector]
 *
 * Example:
 *   pnpm exec tsx scripts/test-subscribe.ts "$TOKEN" "$SERVER_PUBLIC_KEY" \
 *     "id:repo-id::/path/to/worktree"
 */
import nacl from 'tweetnacl'
import WebSocket from 'ws'

const WS_URL = process.env.ORCA_MOBILE_WS_URL ?? 'ws://127.0.0.1:6768'
const token = process.argv[2]
const serverPublicKeyB64 = process.argv[3]
const worktreeSelector = process.argv[4]
const marker = `MOBILE_STREAM_${Date.now()}`

type RpcResponse = {
  id: string
  ok: boolean
  streaming?: true
  result?: Record<string, unknown>
  error?: { code: string; message: string }
  _meta?: { runtimeId: string }
}

type PendingRequest = {
  method: string
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

if (!token || !serverPublicKeyB64) {
  console.error(
    'Usage: pnpm exec tsx scripts/test-subscribe.ts <deviceToken> <serverPublicKeyB64> [worktreeSelector]'
  )
  process.exit(1)
}

let reqId = 0
const pending = new Map<string, PendingRequest>()
let streamSawMarker = false
let readSawMarker = false
let activeHandle: string | null = null
let runtimeId = ''
let scrollbackCols: number | null = null
let scrollbackRows: number | null = null
let serializedLength = 0
const clientKeys = nacl.box.keyPair()
const serverPublicKey = Buffer.from(serverPublicKeyB64, 'base64')
const sharedKey = nacl.box.before(new Uint8Array(serverPublicKey), clientKeys.secretKey)

function nextId(): string {
  reqId += 1
  return `test-${reqId}`
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function encrypt(plaintext: string): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const message = new TextEncoder().encode(plaintext)
  const ciphertext = nacl.box.after(message, nonce, sharedKey)
  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)
  return toBase64(bundle)
}

function decrypt(payload: string): string | null {
  const bundle = fromBase64(payload)
  const nonce = bundle.subarray(0, nacl.box.nonceLength)
  const ciphertext = bundle.subarray(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

function sendRaw(ws: WebSocket, payload: unknown): void {
  ws.send(encrypt(JSON.stringify(payload)))
}

function send(ws: WebSocket, method: string, params?: unknown): Promise<RpcResponse> {
  const id = nextId()
  sendRaw(ws, { id, deviceToken: token, method, params })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}`))
    }, 10_000)
    pending.set(id, {
      method,
      resolve: (response) => {
        clearTimeout(timeout)
        resolve(response)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    })
  })
}

function formatResponse(response: RpcResponse): string {
  return JSON.stringify(response.result ?? response.error ?? response).slice(0, 1000)
}

async function chooseWorktree(ws: WebSocket): Promise<string> {
  if (worktreeSelector) return worktreeSelector

  const response = await send(ws, 'worktree.ps')
  if (!response.ok) {
    throw new Error(`worktree.ps failed: ${formatResponse(response)}`)
  }

  const worktrees = (response.result?.worktrees ?? []) as Array<{
    worktreeId: string
    liveTerminalCount: number
    branch: string
    path: string
  }>
  const selected = worktrees.find((w) => w.liveTerminalCount > 0) ?? worktrees[0]
  if (!selected) {
    throw new Error('No worktrees returned by worktree.ps')
  }

  console.log(`worktree: ${selected.branch || '(no branch)'} ${selected.path}`)
  return `id:${selected.worktreeId}`
}

async function chooseTerminal(ws: WebSocket, worktree: string): Promise<string> {
  const list = await send(ws, 'terminal.list', { worktree })
  if (!list.ok) {
    throw new Error(`terminal.list failed: ${formatResponse(list)}`)
  }

  const terminals = (list.result?.terminals ?? []) as Array<{
    handle: string
    title: string
    preview: string
    lastOutputAt: number | null
  }>

  if (terminals.length > 0) {
    const selected = terminals[0]!
    console.log(`terminal: ${selected.title || selected.handle} ${selected.handle}`)
    return selected.handle
  }

  const created = await send(ws, 'terminal.create', {
    worktree,
    title: 'mobile-stream-repro'
  })
  if (!created.ok) {
    throw new Error(`terminal.create failed: ${formatResponse(created)}`)
  }

  const terminal = created.result?.terminal as { handle?: string; title?: string } | undefined
  if (!terminal?.handle) {
    throw new Error(`terminal.create returned no handle: ${formatResponse(created)}`)
  }
  console.log(`terminal: ${terminal.title || terminal.handle} ${terminal.handle}`)
  return terminal.handle
}

async function run(ws: WebSocket): Promise<void> {
  console.log(`connected: ${WS_URL}`)
  ws.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: toBase64(clientKeys.publicKey) }))
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for e2ee_ready')), 5000)
    ws.once('message', (data) => {
      clearTimeout(timeout)
      const msg = JSON.parse(data.toString()) as { type?: string }
      if (msg.type !== 'e2ee_ready') {
        reject(new Error(`Unexpected handshake response: ${data.toString()}`))
        return
      }
      resolve()
    })
  })

  sendRaw(ws, { type: 'e2ee_auth', deviceToken: token })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for e2ee_authenticated')),
      5000
    )
    ws.once('message', (data) => {
      clearTimeout(timeout)
      const plaintext = decrypt(data.toString())
      const msg = plaintext ? (JSON.parse(plaintext) as { type?: string }) : null
      if (msg?.type !== 'e2ee_authenticated') {
        reject(new Error(`Unexpected auth response: ${data.toString()}`))
        return
      }
      resolve()
    })
  })

  const worktree = await chooseWorktree(ws)
  const handle = await chooseTerminal(ws, worktree)
  activeHandle = handle

  void send(ws, 'terminal.subscribe', { terminal: handle }).catch((error) => {
    console.error(`subscribe failed: ${error.message}`)
  })

  await new Promise((resolve) => setTimeout(resolve, 500))

  const sendResponse = await send(ws, 'terminal.send', {
    terminal: handle,
    text: `echo ${marker}`,
    enter: true
  })
  if (!sendResponse.ok) {
    throw new Error(`terminal.send failed: ${formatResponse(sendResponse)}`)
  }
  console.log(`sent marker: ${marker}`)

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && !streamSawMarker && !readSawMarker) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const read = await send(ws, 'terminal.read', { terminal: handle })
    if (!read.ok) {
      throw new Error(`terminal.read failed: ${formatResponse(read)}`)
    }
    const terminal = read.result?.terminal as { tail?: string[]; preview?: string } | undefined
    const text = [...(terminal?.tail ?? []), terminal?.preview ?? ''].join('\n')
    if (text.includes(marker)) {
      readSawMarker = true
    }
  }

  console.log(`runtime: ${runtimeId || '(unknown)'}`)
  console.log(`scrollbackCols: ${scrollbackCols ?? '(none)'}`)
  console.log(`scrollbackRows: ${scrollbackRows ?? '(none)'}`)
  console.log(`serializedLength: ${serializedLength}`)
  console.log(`streamSawMarker: ${streamSawMarker}`)
  console.log(`readSawMarker: ${readSawMarker}`)

  if (!streamSawMarker && !readSawMarker) {
    throw new Error('terminal output did not reach stream or terminal.read')
  }
}

const ws = new WebSocket(WS_URL)

ws.on('open', () => {
  run(ws)
    .then(() => {
      ws.close()
      process.exit(0)
    })
    .catch((error) => {
      console.error(error.message)
      ws.close()
      process.exit(1)
    })
})

ws.on('message', (data) => {
  const plaintext = decrypt(data.toString())
  if (!plaintext) return
  const response = JSON.parse(plaintext) as RpcResponse
  if (response._meta?.runtimeId) {
    runtimeId = response._meta.runtimeId
  }

  const result = response.result
  if (response.streaming && result?.type === 'data') {
    const chunk = typeof result.chunk === 'string' ? result.chunk : ''
    if (chunk.includes(marker)) {
      streamSawMarker = true
    }
  }

  if (response.streaming && result?.type === 'scrollback') {
    const lines = Array.isArray(result.lines) ? result.lines.join('\n') : String(result.lines ?? '')
    scrollbackCols = typeof result.cols === 'number' ? result.cols : null
    scrollbackRows = typeof result.rows === 'number' ? result.rows : null
    serializedLength = typeof result.serialized === 'string' ? result.serialized.length : 0
    if (lines.includes(marker)) {
      streamSawMarker = true
    }
    if (typeof result.serialized === 'string' && result.serialized.includes(marker)) {
      streamSawMarker = true
    }
  }

  const pendingRequest = pending.get(response.id)
  if (!pendingRequest) {
    return
  }

  if (response.streaming && pendingRequest.method === 'terminal.subscribe') {
    return
  }

  pending.delete(response.id)
  pendingRequest.resolve(response)
})

ws.on('close', () => {
  for (const request of pending.values()) {
    request.reject(new Error('WebSocket closed'))
  }
  pending.clear()
})

ws.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`)
  if (activeHandle) {
    console.error(`active terminal: ${activeHandle}`)
  }
  process.exit(1)
})
