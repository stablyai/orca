import './mock-descendant-sweep'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient } from './client'
import { isDaemonRequestFrame, isHelloFrame } from './daemon-client-frame-guards'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PROTOCOL_VERSION } from './types'

function createMockSubprocess(): SubprocessHandle {
  let notifyExit: ((code: number) => void) | null = null
  const exit = (): void => notifyExit?.(0)
  return {
    pid: 44445,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill: exit,
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: exit,
    signal() {},
    onData() {},
    onExit(callback) {
      notifyExit = callback
    },
    dispose() {}
  }
}

/** Writes raw lines and resolves with whatever came back once the daemon closes the socket. */
function sendRawFrames(socketPath: string, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ path: socketPath })
    let received = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`daemon kept the connection open; got: ${received}`))
    }, 5_000)
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(received)
    })
    socket.on('connect', () => socket.write(lines.map((line) => `${line}\n`).join('')))
  })
}

describe('frame guards', () => {
  it.each([null, 7, 'hello', [], {}, { type: 'hello' }, { type: 'hello', version: '1' }])(
    'rejects %j as a hello',
    (frame) => expect(isHelloFrame(frame)).toBe(false)
  )

  it('accepts a well-formed hello', () => {
    expect(
      isHelloFrame({ type: 'hello', version: 1, token: 't', clientId: 'c', role: 'control' })
    ).toBe(true)
  })

  it.each([null, {}, { id: 123, type: 'ping' }, { id: 'a' }, { type: 'ping' }])(
    'rejects %j as a request',
    (frame) => expect(isDaemonRequestFrame(frame)).toBe(false)
  )
})

describe.skipIf(process.platform === 'win32')('malformed client frames (#17841)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let client: DaemonClient | null = null

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-frames-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    await client.request('createOrAttach', { sessionId: 'survivor', cols: 80, rows: 24 })
  })

  afterEach(async () => {
    client?.disconnect()
    client = null
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  function validHello(): string {
    return JSON.stringify({
      type: 'hello',
      version: PROTOCOL_VERSION,
      token: readFileSync(tokenPath, 'utf8').trim(),
      clientId: 'raw-client',
      role: 'control'
    })
  }

  async function expectDaemonStillServing(): Promise<void> {
    const listed = await client!.request<{ sessions: { sessionId: string; isAlive: boolean }[] }>(
      'listSessions',
      undefined
    )
    expect(listed.sessions).toContainEqual(
      expect.objectContaining({ sessionId: 'survivor', isAlive: true })
    )
  }

  it.each(['null', '42', '"hello"', '[]', '{}', '{"type":"hello","version":"x"}'])(
    'refuses the pre-auth frame %s on that connection only',
    async (frame) => {
      const reply = await sendRawFrames(socketPath, [frame])
      expect(reply).toContain('Expected hello')
      await expectDaemonStillServing()
    }
  )

  it.each(['null', '{}', '{"type":"ping"}', '{"id":123,"type":"ping"}'])(
    'drops the authenticated connection that sends %s',
    async (frame) => {
      const reply = await sendRawFrames(socketPath, [validHello(), frame])
      expect(reply).toContain('"ok":true')
      await expectDaemonStillServing()
    }
  )

  it('still answers a well-formed request after a bad one on another connection', async () => {
    await sendRawFrames(socketPath, [validHello(), '{"method":"x"}'])
    await expect(client!.request('ping', undefined)).resolves.toBeDefined()
  })
})
