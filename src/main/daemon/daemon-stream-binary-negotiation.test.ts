import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DaemonServer } from './daemon-server'
import { createNoopDaemonFileLog } from './daemon-file-log'
import { DaemonClient } from './client'
import { sendDaemonHello } from './daemon-client-hello-handshake'
import { encodeBinaryStreamDataFrame } from './daemon-stream-binary-framing'
import { encodeNdjson } from './ndjson'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PROTOCOL_VERSION } from './types'
import { getDaemonSocketPath } from './daemon-spawner'

const TERMINAL_TEXT = '\x1b[1;32m✔\x1b[0m done ┌──┐ \u{1F680} "q" \\\r\n'

function createMockSubprocess(): SubprocessHandle & { emit: (data: string) => void } {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 55555,
    getForegroundProcess: vi.fn(() => null),
    confirmForegroundProcess: vi.fn(async () => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    emit(data: string) {
      onDataCb?.(data)
    }
  }
}

function dataOf(event: unknown): string | null {
  if (
    typeof event !== 'object' ||
    event === null ||
    !('event' in event) ||
    event.event !== 'data'
  ) {
    return null
  }
  const payload = 'payload' in event ? event.payload : null
  return typeof payload === 'object' && payload !== null && 'data' in payload
    ? String(payload.data)
    : null
}

function waitForData(client: DaemonClient, expected: string): Promise<string> {
  return new Promise((resolve) => {
    let received = ''
    const off = client.onEvent((event) => {
      const data = dataOf(event)
      if (data !== null) {
        received += data
        if (received.length >= expected.length) {
          off()
          resolve(received)
        }
      }
    })
  })
}

describe('daemon stream framing negotiation', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer | null = null
  let fakeDaemon: Server | null = null
  let client: DaemonClient | null = null
  let acceptedStreams: unknown[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-binary-stream-test-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
  })

  afterEach(async () => {
    client?.disconnect()
    client = null
    await server?.shutdown()
    server = null
    await new Promise<void>((resolve) =>
      fakeDaemon ? fakeDaemon.close(() => resolve()) : resolve()
    )
    fakeDaemon = null
    rmSync(dir, { recursive: true, force: true })
  })

  async function startRealDaemon(): Promise<{ emit: (data: string) => void }> {
    let subprocess: ReturnType<typeof createMockSubprocess> | null = null
    acceptedStreams = []
    const log = createNoopDaemonFileLog()
    server = new DaemonServer({
      socketPath,
      tokenPath,
      log: {
        ...log,
        log: (event, details) => {
          if (event === 'client-hello-accepted' && details?.role === 'stream') {
            acceptedStreams.push(details.streamFraming)
          }
        }
      },
      spawnSubprocess: () => {
        subprocess = createMockSubprocess()
        return subprocess
      }
    })
    await server.start()
    return { emit: (data) => subprocess?.emit(data) }
  }

  it('switches a new client and a new daemon to binary frames without changing events', async () => {
    const daemon = await startRealDaemon()
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    await client.request('createOrAttach', { sessionId: 'session-1', cols: 80, rows: 24 })

    expect(acceptedStreams).toEqual(['binary-v1'])

    const bulk = TERMINAL_TEXT.repeat(20_000)
    const received = waitForData(client, bulk)
    daemon.emit(bulk)
    expect(await received).toBe(bulk)
  })

  it('keeps NDJSON for a client that does not ask, which is what every older main sends', async () => {
    await startRealDaemon()
    const socket = connect(socketPath)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const outcome = await sendDaemonHello({
      socket,
      token: readFileSync(tokenPath, 'utf-8').trim(),
      role: 'control',
      timeoutMs: 2000,
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'legacy-client',
      requestBinaryStream: false
    })
    const stream = connect(socketPath)
    await new Promise<void>((resolve) => stream.once('connect', resolve))
    const streamOutcome = await sendDaemonHello({
      socket: stream,
      token: readFileSync(tokenPath, 'utf-8').trim(),
      role: 'stream',
      timeoutMs: 2000,
      protocolVersion: PROTOCOL_VERSION,
      clientId: 'legacy-client',
      requestBinaryStream: false
    })
    expect(outcome.streamFraming).toBe('ndjson')
    expect(streamOutcome.streamFraming).toBe('ndjson')
    expect(acceptedStreams).toEqual(['ndjson'])
    stream.destroy()
    socket.destroy()
  })

  // A pre-binary daemon (v39, v41, v44 today) ignores the request and answers a plain hello.
  function startFakeDaemon(
    protocolVersion: number,
    afterStreamHello: (hello: { streamFraming?: string }) => Buffer
  ): Promise<void> {
    writeFileSync(tokenPath, 'fake-token\n')
    const identity = { pid: process.pid, startedAtMs: Date.now() - 1000, launchNonce: 'fake' }
    fakeDaemon = createServer((socket: Socket) => {
      let buffered = ''
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8')
        const newline = buffered.indexOf('\n')
        if (newline === -1) {
          return
        }
        const hello: { role: string; version: number; streamFraming?: string } = JSON.parse(
          buffered.slice(0, newline)
        )
        buffered = buffered.slice(newline + 1)
        expect(hello.version).toBe(protocolVersion)
        const reply = Buffer.from(
          encodeNdjson({ type: 'hello', ok: true, daemonIdentity: identity }),
          'utf8'
        )
        // One write, so the client must pick the event out of the hello's own read.
        socket.write(
          hello.role === 'stream' ? Buffer.concat([reply, afterStreamHello(hello)]) : reply
        )
      })
    })
    return new Promise((resolve) => fakeDaemon!.listen(socketPath, resolve))
  }

  it.each([39, 41, 44])(
    'falls back to NDJSON against a v%i daemon and keeps an event that shares the hello read',
    async (protocolVersion) => {
      let requested: string | undefined
      await startFakeDaemon(protocolVersion, (hello) => {
        requested = hello.streamFraming
        return Buffer.from(
          encodeNdjson({
            type: 'event',
            event: 'data',
            sessionId: 'session-1',
            payload: { data: TERMINAL_TEXT }
          }),
          'utf8'
        )
      })
      client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
      const received = waitForData(client, TERMINAL_TEXT)
      await client.ensureConnected()
      expect(requested).toBe('binary-v1')
      expect(await received).toBe(TERMINAL_TEXT)
    }
  )

  it('decodes binary frames that arrive in the same read as the accepting hello', async () => {
    writeFileSync(tokenPath, 'fake-token\n')
    const identity = { pid: process.pid, startedAtMs: Date.now() - 1000, launchNonce: 'fake' }
    fakeDaemon = createServer((socket: Socket) => {
      socket.once('data', (chunk) => {
        const hello: { role: string } = JSON.parse(chunk.toString('utf8').trim())
        const ack = encodeNdjson({
          type: 'hello',
          ok: true,
          daemonIdentity: identity,
          ...(hello.role === 'stream' ? { streamFraming: 'binary-v1' } : {})
        })
        socket.write(
          hello.role === 'stream'
            ? Buffer.concat([
                Buffer.from(ack, 'utf8'),
                encodeBinaryStreamDataFrame('session-1', TERMINAL_TEXT)
              ])
            : ack
        )
      })
    })
    await new Promise<void>((resolve) => fakeDaemon!.listen(socketPath, resolve))
    client = new DaemonClient({ socketPath, tokenPath })
    const received = waitForData(client, TERMINAL_TEXT)
    await client.ensureConnected()
    expect(await received).toBe(TERMINAL_TEXT)
  })
})
