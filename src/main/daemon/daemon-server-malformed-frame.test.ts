import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { isDispatchableRequest } from './daemon-client-connections'
import { getDaemonSocketPath } from './daemon-spawner'
import { encodeNdjson } from './ndjson'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PROTOCOL_VERSION, type DaemonRequest } from './types'

function unusedSubprocess(): SubprocessHandle {
  throw new Error('Test must not create a PTY')
}

type DaemonServerPrivate = {
  handleRequest(socket: unknown, clientId: string, request: DaemonRequest): Promise<void>
}

/** Every shape the parser hands through that carries no id a reply could be correlated against. */
const UNROUTABLE_FRAMES = [null, 42, 'string', [], {}, { type: 'ping' }, { id: 42 }, { id: '' }]

/**
 * The daemon is the process deliberately kept alive so terminals outlive the runtime, the
 * supervisor and an update. Killing it destroys every terminal on the host — the same harm
 * `KillMode=process` exists to prevent, reached from the client side instead.
 *
 * A frame with no usable `id` used to do exactly that: the `.id` read sat one line above the
 * try/catch that was already there, so the TypeError escaped as an unhandled rejection and
 * the daemon's uncaughtException handler rethrew it.
 */
describe('malformed control frames', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  const sockets: Socket[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-malformed-frame-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
  })

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy()
    }
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(): Promise<void> {
    server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: unusedSubprocess })
    await server.start()
  }

  async function openSocket(): Promise<Socket> {
    const socket = connect(socketPath)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return socket
  }

  /** Reads exactly one NDJSON frame, so each step can await the daemon's own answer. */
  function nextFrame(socket: Socket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      socket.once('data', (data) => {
        resolve(JSON.parse(data.toString().split('\n')[0]) as Record<string, unknown>)
      })
      socket.once('error', reject)
      socket.once('close', () => reject(new Error('closed before a frame arrived')))
    })
  }

  async function connectControl(clientId: string): Promise<Socket> {
    const socket = await openSocket()
    socket.write(
      encodeNdjson({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf8').trim(),
        clientId,
        role: 'control'
      })
    )
    expect(await nextFrame(socket)).toMatchObject({ type: 'hello', ok: true })
    return socket
  }

  /** A ping round-trip is the proof of life: it needs the parser, the router and the reply. */
  async function expectStillServing(socket: Socket, id: string): Promise<void> {
    socket.write(encodeNdjson({ id, type: 'ping' }))
    expect(await nextFrame(socket)).toMatchObject({ id, ok: true, payload: { pong: true } })
  }

  it.skipIf(process.platform === 'win32')(
    'drops unroutable frames at the socket and keeps serving the same connection',
    async () => {
      await startServer()
      const control = await connectControl('control-1')

      // Fed as raw bytes through the real NDJSON parser, which is the boundary the guard
      // sits on. Driving `handleRequest` directly would skip it entirely.
      for (const frame of UNROUTABLE_FRAMES) {
        control.write(`${JSON.stringify(frame)}\n`)
      }

      // "Nothing threw" would pass equally against a daemon that had already exited, so
      // prove the same connection still round-trips after the malformed frames.
      await expectStillServing(control, 'after-malformed')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'survives a first frame that is not an object and keeps accepting new clients',
    async () => {
      await startServer()

      // `null` never reached the id guard: the hello handler read `.type` off it first, and
      // that throw is synchronous inside the socket's data handler — before any token check,
      // so it needed no credentials at all.
      const hostile = await openSocket()
      hostile.write('null\n')
      expect(await nextFrame(hostile)).toMatchObject({ type: 'hello', ok: false })

      await expectStillServing(await connectControl('control-after-hostile'), 'after-hostile')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'error-replies rather than drops when the id is usable but the method is not',
    async () => {
      await startServer()
      const control = await connectControl('control-1')

      // The boundary stops at `id` on purpose. A frame carrying one is answerable, so an
      // unknown or absent `type` belongs to the router and gets a reply — pinned here so
      // that tightening `isDispatchableRequest` to check `type` fails loudly rather than
      // quietly demoting these to drops.
      for (const frame of [{ id: 'unknown-method', type: 'nope' }, { id: 'no-method' }]) {
        control.write(encodeNdjson(frame))
        expect(await nextFrame(control)).toMatchObject({
          id: frame.id,
          ok: false,
          error: expect.stringContaining('Unknown request type')
        })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'returns rather than throwing when a caller bypasses the parser',
    async () => {
      await startServer()
      const daemon = server as unknown as DaemonServerPrivate

      // The parser guard cannot protect `handleRequest` from its in-process callers, so the
      // id read carries its own guard. Without it the rejection escapes as an unhandled one.
      for (const frame of [...UNROUTABLE_FRAMES, undefined]) {
        await expect(
          daemon.handleRequest({}, 'control-1', frame as unknown as DaemonRequest)
        ).resolves.toBeUndefined()
      }
    }
  )
})

describe('isDispatchableRequest', () => {
  // A reply has to be correlated against an id, so a frame without one is undispatchable
  // rather than merely unknown: an unknown method still gets an error reply.
  it.each([...UNROUTABLE_FRAMES, undefined])('refuses %o', (message) => {
    expect(isDispatchableRequest(message)).toBe(false)
  })

  it('accepts a frame carrying a non-empty string id', () => {
    expect(isDispatchableRequest({ id: 'notify_1', type: 'write' })).toBe(true)
  })
})
