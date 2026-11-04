import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'

const appDirectory = fileURLToPath(new URL('..', import.meta.url))
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
})

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('missing test port')
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return address.port
}

async function startRelay(port: number): Promise<ChildProcess> {
  const dataDirectory = mkdtempSync(resolve(tmpdir(), 'orca-relay-sigterm-exit-'))
  const url = `http://127.0.0.1:${port}`
  const child = spawnProcess({
    program: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: appDirectory,
    // Explicit so an inherited DATABASE_URL cannot point the relay at a shared database.
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PORT: String(port),
      ORCA_RELAY_PUBLIC_URL: url,
      ORCA_RELAY_CELL_URL: url,
      ORCA_RELAY_AUTH_ISSUER: 'http://127.0.0.1:9',
      ORCA_RELAY_JWKS_URL: 'http://127.0.0.1:9/jwks',
      ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'test-assignment-key-with-at-least-32-bytes',
      ORCA_RELAY_DATA_DIR: dataDirectory,
      ORCA_RELAY_ADMIN_AUDIENCE: `${url}/v1/admin/drain`,
      ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
      ORCA_RELAY_ADMIN_JWKS_URL: 'http://127.0.0.1:9/jwks'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    rmSync(dataDirectory, { recursive: true, force: true })
  })
  await new Promise<void>((resolveReady, reject) => {
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('[orca-relay] listening')) {
        resolveReady()
      }
    })
    child.once('exit', (code) => reject(new Error(`relay exited before ready: ${code}\n${stderr}`)))
  })
  return child
}

async function silentTcpPeer(port: number, firstBytes?: string): Promise<Socket> {
  const peer = connect(port, '127.0.0.1')
  peer.on('error', () => undefined)
  await new Promise<void>((resolveConnect) => peer.once('connect', () => resolveConnect()))
  if (firstBytes) {
    peer.write(firstBytes)
  }
  return peer
}

// Pauses reading so the peer never answers the relay's close frame.
async function unresponsiveWebSocketPeer(port: number): Promise<Socket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect/abcdefghijklmnop`)
  socket.on('error', () => undefined)
  await new Promise<void>((resolveOpen) => socket.once('open', () => resolveOpen()))
  const raw = (socket as unknown as { _socket: Socket })._socket
  raw.pause()
  return raw
}

// Resolves once the listener refuses new connections, i.e. the relay has begun shutting down.
async function waitUntilListenerClosed(port: number): Promise<void> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const accepted = await new Promise<boolean>((resolveProbe) => {
      const probe = connect(port, '127.0.0.1')
      probe.once('connect', () => {
        probe.destroy()
        resolveProbe(true)
      })
      probe.once('error', () => resolveProbe(false))
    })
    if (!accepted) {
      return
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new Error('relay kept accepting connections after SIGTERM')
}

// Peers that are not idle to server.close(); unbounded, a silent one held exit until SIGKILL.
it.each([
  ['silent TCP peer', (port: number) => silentTcpPeer(port)],
  ['partial-headers peer', (port: number) => silentTcpPeer(port, 'GET /healthz HTTP/1.1\r\nHost: x\r\n')],
  ['unresponsive upgraded WebSocket peer', unresponsiveWebSocketPeer]
])('exits within the shutdown bound on SIGTERM with a %s', async (_name, openPeer) => {
  const port = await unusedPort()
  const relay = await startRelay(port)
  const peer = await openPeer(port)
  cleanups.push(() => peer.destroy())
  const peerClosed = new Promise<void>((resolveClose) => peer.once('close', () => resolveClose()))

  const startedAt = Date.now()
  const exited = new Promise<number | null>((resolveExit) =>
    relay.once('exit', (code) => resolveExit(code))
  )
  relay.kill('SIGTERM')
  // A second signal must not restart or extend shutdown. Send it only once the first has been
  // handled, so the two cannot coalesce into one delivery.
  await waitUntilListenerClosed(port)
  relay.kill('SIGTERM')

  expect(await exited).toBe(0)
  // Under the 10 s backstop: the socket grace, not the backstop, released it.
  expect(Date.now() - startedAt).toBeLessThan(9_000)
  // A paused peer only observes the relay's FIN once it reads again.
  peer.resume()
  await peerClosed
}, 15_000)
