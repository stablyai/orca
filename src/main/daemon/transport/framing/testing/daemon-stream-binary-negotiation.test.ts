import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DaemonClient } from '../../client/daemon-client'
import { encodeNdjson } from '../../../../../shared/main-process-ndjson-framer'
import { getDaemonSocketPath } from '../../../launch/daemon-spawner'

const TERMINAL_TEXT = '\x1b[1;32m✔\x1b[0m done ┌──┐ \u{1F680} "q" \\\r\n'

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
  let fakeDaemon: Server | null = null
  let client: DaemonClient | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-binary-stream-test-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
  })

  afterEach(async () => {
    client?.disconnect()
    client = null
    await new Promise<void>((resolve) =>
      fakeDaemon ? fakeDaemon.close(() => resolve()) : resolve()
    )
    fakeDaemon = null
    rmSync(dir, { recursive: true, force: true })
  })

  // Legacy daemons ignore binary negotiation and reply with an ordinary hello.
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
        // Coalesce hello and data so the client must preserve the handshake read's remainder.
        socket.write(
          hello.role === 'stream' ? Buffer.concat([reply, afterStreamHello(hello)]) : reply
        )
      })
    })
    return new Promise((resolve) => fakeDaemon!.listen(socketPath, resolve))
  }

  it.each([39])(
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
})
