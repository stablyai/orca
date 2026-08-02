import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import process from 'node:process'
import WebSocket from 'ws'

if (process.env.ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE !== '1') {
  console.log('SKIPPED: set ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE=1 to run the disposable smoke')
  process.exit(0)
}

const threadId = process.argv[2]?.trim()
if (!threadId || process.platform === 'win32') {
  throw new Error(
    'usage: ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE=1 node ... <thread-id> (Unix only)'
  )
}

const socketRoot = `/tmp/ocw-smoke-${process.getuid?.() ?? 'local'}`
const socketPath = `${socketRoot}/${createHash('sha256').update(threadId).digest('hex').slice(0, 12)}.sock`
await mkdir(socketRoot, { recursive: true, mode: 0o700 })
await chmod(socketRoot, 0o700)
await rm(socketPath, { force: true })

const child = spawn('codex', ['app-server', '--listen', `unix://${socketPath}`], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: process.env
})

let socket
try {
  await waitForSocket(socketPath, child)
  await chmod(socketPath, 0o600)
  socket = new WebSocket('ws://localhost/rpc', {
    perMessageDeflate: false,
    createConnection: () => createConnection(socketPath)
  })
  await onceOpen(socket)
  let requestId = 0
  const request = (method, params) => rpc(socket, ++requestId, method, params)
  const initialized = await request('initialize', {
    clientInfo: { name: 'orca_smoke', title: 'Orca smoke', version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  socket.send(JSON.stringify({ method: 'initialized' }))
  const read = await request('thread/read', { threadId, includeTurns: false })
  if (initialized?.platformFamily !== 'unix' || read?.thread?.id !== threadId) {
    throw new Error('live smoke identity check failed')
  }
  console.log(
    'PASS: private Unix transport initialized and read the requested thread; no turn started'
  )
} finally {
  socket?.terminate()
  child.kill('SIGTERM')
  await rm(socketRoot, { recursive: true, force: true })
}

async function waitForSocket(path, server) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error('Codex app-server exited before smoke readiness')
    }
    try {
      if ((await stat(path)).isSocket()) {
        return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Codex app-server smoke socket timed out')
}

function onceOpen(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once('open', resolve)
    webSocket.once('error', reject)
  })
}

function rpc(webSocket, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) {
        return
      }
      webSocket.off('message', onMessage)
      if (message.error) {
        reject(new Error(message.error.message ?? `${method} failed`))
      } else {
        resolve(message.result)
      }
    }
    webSocket.on('message', onMessage)
    webSocket.send(JSON.stringify({ id, method, params }))
  })
}
