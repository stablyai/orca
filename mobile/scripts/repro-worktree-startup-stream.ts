/**
 * Captures the mobile WebSocket stream during worktree startup.
 *
 * Usage:
 *   pnpm exec tsx mobile/scripts/repro-worktree-startup-stream.ts <repoSelector> <worktreeName> [startupCommand]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import WebSocket from 'ws'

const WS_URL = process.env.ORCA_MOBILE_WS_URL ?? 'ws://127.0.0.1:6768'
const USER_DATA =
  process.env.ORCA_USER_DATA ?? `${process.env.HOME}/Library/Application Support/orca-dev`
const repoSelector = process.argv[2]
const worktreeName = process.argv[3]
const startupCommand = process.argv[4] || 'claude'
const ESC = String.fromCharCode(27)

type RpcResponse = {
  id: string
  ok: boolean
  streaming?: true
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

type PendingRequest = {
  method: string
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

type TerminalInfo = {
  handle: string
  title: string | null
}

type Capture = {
  handle: string
  title: string | null
  scrollback: Record<string, unknown> | null
  chunks: string[]
}

if (!repoSelector || !worktreeName) {
  console.error(
    'Usage: pnpm exec tsx mobile/scripts/repro-worktree-startup-stream.ts <repoSelector> <worktreeName> [startupCommand]'
  )
  process.exit(1)
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

const devices = readJson<Array<{ token: string }>>(join(USER_DATA, 'orca-devices.json'))
const token = devices[0]?.token
const keypair = readJson<{ publicKeyB64: string }>(join(USER_DATA, 'orca-e2ee-keypair.json'))

if (!token || !keypair.publicKeyB64) {
  throw new Error(`Missing mobile token or E2EE public key in ${USER_DATA}`)
}

let reqId = 0
const pending = new Map<string, PendingRequest>()
const streamListeners = new Map<string, (result: Record<string, unknown>) => void>()
const clientKeys = nacl.box.keyPair()
const serverPublicKey = Buffer.from(keypair.publicKeyB64, 'base64')
const sharedKey = nacl.box.before(new Uint8Array(serverPublicKey), clientKeys.secretKey)

function nextId(): string {
  reqId += 1
  return `startup-repro-${reqId}`
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
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }
  const nonce = bundle.subarray(0, nacl.box.nonceLength)
  const ciphertext = bundle.subarray(nacl.box.nonceLength)
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)
  return plaintext ? new TextDecoder().decode(plaintext) : null
}

function sendRaw(ws: WebSocket, payload: unknown): void {
  ws.send(encrypt(JSON.stringify(payload)))
}

function send(
  ws: WebSocket,
  method: string,
  params?: unknown,
  timeoutMs = 30_000
): Promise<RpcResponse> {
  const id = nextId()
  sendRaw(ws, { id, deviceToken: token, method, params })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}`))
    }, timeoutMs)
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

function formatError(response: RpcResponse): string {
  return JSON.stringify(response.error ?? response.result ?? response).slice(0, 1000)
}

function stripAnsi(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- intentional terminal escape stripping for repro summaries
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      // eslint-disable-next-line no-control-regex -- intentional terminal escape stripping for repro summaries
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '\n')
  )
}

function normalizePreview(value: string): string {
  return stripAnsi(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n')
}

async function waitForTerminals(ws: WebSocket, worktreeId: string): Promise<TerminalInfo[]> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const response = await send(ws, 'terminal.list', { worktree: worktreeId })
    if (!response.ok) {
      throw new Error(`terminal.list failed: ${formatError(response)}`)
    }
    const terminals = (response.result?.terminals ?? []) as Array<{
      handle?: string
      title?: string | null
    }>
    const handles = terminals
      .filter((terminal): terminal is { handle: string; title?: string | null } =>
        Boolean(terminal.handle)
      )
      .map((terminal) => ({ handle: terminal.handle, title: terminal.title ?? null }))
    if (handles.length > 0) {
      return handles
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Timed out waiting for startup terminals')
}

async function subscribe(ws: WebSocket, capture: Capture): Promise<void> {
  const id = nextId()
  streamListeners.set(id, (result) => {
    if (result.type === 'scrollback') {
      capture.scrollback = result
      return
    }
    if (result.type === 'data' && typeof result.chunk === 'string') {
      capture.chunks.push(result.chunk)
    }
  })
  sendRaw(ws, {
    id,
    deviceToken: token,
    method: 'terminal.subscribe',
    params: { terminal: capture.handle }
  })
}

function summarize(capture: Capture): Record<string, unknown> {
  const serialized =
    typeof capture.scrollback?.serialized === 'string' ? capture.scrollback.serialized : ''
  const live = capture.chunks.join('')
  const serializedPreview = normalizePreview(serialized)
  const livePreview = normalizePreview(live)
  return {
    handle: capture.handle,
    title: capture.title,
    cols: capture.scrollback?.cols ?? null,
    rows: capture.scrollback?.rows ?? null,
    serializedBytes: Buffer.byteLength(serialized),
    liveBytes: Buffer.byteLength(live),
    liveChunks: capture.chunks.length,
    serializedSgr: (serialized.match(new RegExp(`${ESC}\\[[0-9;:]*m`, 'g')) ?? []).length,
    liveSgr: (live.match(new RegExp(`${ESC}\\[[0-9;:]*m`, 'g')) ?? []).length,
    livePreviewContainedInSerialized:
      livePreview.length > 0 && stripAnsi(serialized).includes(livePreview.split('\n')[0] ?? ''),
    serializedPreview,
    livePreview
  }
}

function save(captures: Capture[], worktreeName: string): string {
  const dir = join(process.cwd(), 'terminal-startup-repro', worktreeName)
  mkdirSync(dir, { recursive: true })
  for (const capture of captures) {
    const base = capture.handle.replace(/[^a-z0-9_-]/gi, '-')
    const serialized =
      typeof capture.scrollback?.serialized === 'string' ? capture.scrollback.serialized : ''
    writeFileSync(join(dir, `${base}.serialized.ansi`), serialized)
    writeFileSync(join(dir, `${base}.live.ansi`), capture.chunks.join(''))
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(capture, null, 2))
  }
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(captures.map(summarize), null, 2))
  return dir
}

async function run(ws: WebSocket): Promise<void> {
  ws.send(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: toBase64(clientKeys.publicKey)
    })
  )

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

  const created = await send(
    ws,
    'worktree.create',
    { repo: repoSelector, name: worktreeName, startupCommand },
    120_000
  )
  if (!created.ok) {
    throw new Error(`worktree.create failed: ${formatError(created)}`)
  }
  const worktree = created.result?.worktree as { id?: string; path?: string } | undefined
  if (!worktree?.id) {
    throw new Error(`worktree.create returned no worktree id: ${formatError(created)}`)
  }

  console.log(`worktree: ${worktree.id}`)
  const terminals = await waitForTerminals(ws, worktree.id)
  console.log(`terminals: ${terminals.map((terminal) => terminal.handle).join(', ')}`)
  const captures = terminals.map((terminal) => ({
    handle: terminal.handle,
    title: terminal.title,
    scrollback: null,
    chunks: []
  }))
  for (const capture of captures) {
    await subscribe(ws, capture)
  }

  await new Promise((resolve) => setTimeout(resolve, 15_000))
  for (const capture of captures) {
    await send(ws, 'terminal.unsubscribe', { subscriptionId: capture.handle }).catch(() => null)
  }
  const dir = save(captures, worktreeName)
  console.table(captures.map(summarize))
  console.log(`saved: ${dir}`)
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
  const raw = data.toString()
  if (raw.startsWith('{')) {
    return
  }
  const plaintext = decrypt(raw)
  if (!plaintext) return

  const response = JSON.parse(plaintext) as RpcResponse
  const result = response.result
  const streamListener = streamListeners.get(response.id)
  if (streamListener && response.ok && (response.streaming || result?.type)) {
    streamListener(result ?? {})
    return
  }

  const request = pending.get(response.id)
  if (!request || request.method === 'terminal.subscribe') return
  pending.delete(response.id)
  request.resolve(response)
})

ws.on('close', () => {
  for (const request of pending.values()) {
    request.reject(new Error('WebSocket closed'))
  }
  pending.clear()
})

ws.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`)
  process.exit(1)
})
