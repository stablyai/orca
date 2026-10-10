import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import type { spawnProcess } from '../../shared/child-process/run-process'
import {
  openZcodeAppServerConnection,
  ZcodeAppServerTimeoutError
} from './zcode-app-server-connection'
import { isZcodeAppServerRequestError } from './zcode-app-server-request-error'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * A real `node -e` child speaking the same NDJSON framing the ZCode app-server
 * does. Slower than a stub, but it is the only thing that proves the spawn and
 * both traffic directions actually work end to end.
 */
const FAKE_APP_SERVER = String.raw`
  const readline = require('node:readline')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'session/create') {
      send({ method: 'session/event', params: { type: 'session.created', sessionId: 'sess-new', seq: 1 } })
      return send({ id: message.id, result: { session: { sessionId: 'sess-new' }, messages: [] } })
    }
    if (message.method === 'session/resume') {
      if (message.params.sessionId === 'sess-known') {
        return send({
          id: message.id,
          result: { session: { sessionId: 'sess-known' }, messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] }] }
        })
      }
      return send({ id: message.id, error: { code: -32004, message: 'session unavailable' } })
    }
    if (message.method === 'session/send') {
      send({ method: 'session/event', params: { type: 'turn.started', sessionId: message.params.sessionId, turnId: 't1', seq: 2, timestamp: Date.now() } })
      send({ method: 'session/event', params: { type: 'turn.completed', sessionId: message.params.sessionId, turnId: 't1', seq: 3, resultType: 'success', timestamp: Date.now() } })
      return send({ id: message.id, result: { sessionId: message.params.sessionId, accepted: true, stateRevision: 2 } })
    }
    if (message.method === 'session/stop') {
      return send({ id: message.id, result: {} })
    }
    if (message.method === 'test/ask') {
      return send({ id: 'server-1', method: 'interaction/requestPermission', params: { requestId: 'p1', sessionId: 's', toolName: 'bash' } })
    }
    if (message.method === 'test/refuse') {
      return send({ id: message.id, error: { code: -32602, message: 'bad params' } })
    }
    if (message.method === 'test/slow') {
      return setTimeout(() => send({ id: message.id, result: {} }), 5000)
    }
    if (message.method === 'test/exit') {
      process.exit(0)
    }
    return send({ id: message.id, result: {} })
  })
`

/** Reads a field off an unknown JSON-RPC result without an assertion. */
function readField(result: unknown, key: string): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return undefined
  }
  return result[key]
}

type FakeChild = ReturnType<typeof stubChild>

/** An in-memory child: no process, full control of stdout and exit. */
function stubChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4321
  })
  return child
}

function fakeSpawn(children: FakeChild[]): typeof spawnProcess {
  const spawnStub = (spec: ProcessSpec): unknown => {
    const child = stubChild()
    children.push(child)
    void spec
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  // SAFETY: the stub is an EventEmitter standing in for a ChildProcess; the
  // connection only uses stdin/stdout/stderr/pid/on(), which the stub provides.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EventEmitter stub impersonates ChildProcess for spawnProcess.
  return spawnStub as unknown as typeof spawnProcess
}

const TEST_TIMEOUT_MS = 20_000

describe('openZcodeAppServerConnection', () => {
  it(
    'creates a session and answers a send over the real framing',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const connection = await openZcodeAppServerConnection({
        command: process.execPath,
        args: ['-e', FAKE_APP_SERVER]
      })
      try {
        const snapshot = await connection.request('session/create', {
          workspace: { workspacePath: 'C:/work', workspaceKey: 'C:/work' }
        })
        const session = readField(snapshot, 'session')
        expect(readField(session, 'sessionId')).toBe('sess-new')

        const events: string[] = []
        void events

        await connection.request('session/send', {
          sessionId: 'sess-new',
          content: 'hi'
        })
        expect(events).toEqual([])
      } finally {
        expect(await connection.close()).toBe(true)
      }
    }
  )

  it('surfaces a provider refusal as a ZcodeAppServerRequestError', async () => {
    const connection = await openZcodeAppServerConnection({
      command: process.execPath,
      args: ['-e', FAKE_APP_SERVER]
    })
    try {
      const error = await connection
        .request('session/resume', { sessionId: 'sess-missing' })
        .catch((caught: unknown) => caught)
      expect(isZcodeAppServerRequestError(error)).toBe(true)
      if (isZcodeAppServerRequestError(error)) {
        expect(error.code).toBe(-32004)
      }
    } finally {
      expect(await connection.close()).toBe(true)
    }
  })

  it('delivers server requests and carries the response back', async () => {
    const requests: { id: number | string; method: string }[] = []
    const replies: unknown[] = []
    const connection = await openZcodeAppServerConnection(
      { command: process.execPath, args: ['-e', FAKE_APP_SERVER] },
      {
        onServerRequest: (request) => {
          requests.push({ id: request.id, method: request.method })
          replies.push({ decision: 'allow' })
          connection.respond(request.id, { decision: 'allow' })
        }
      }
    )
    try {
      // The fake answers a server request INSTEAD of the ask; the ask itself
      // never resolves, which is the real shape of a tool approval too.
      connection.request('test/ask', {}).catch(() => {})
      await vi.waitFor(() =>
        expect(requests).toEqual([{ id: 'server-1', method: 'interaction/requestPermission' }])
      )
      expect(replies).toEqual([{ decision: 'allow' }])
    } finally {
      expect(await connection.close()).toBe(true)
    }
  })

  it('times a request out and keeps the connection usable for stop', async () => {
    const connection = await openZcodeAppServerConnection(
      { command: process.execPath, args: ['-e', FAKE_APP_SERVER] },
      {}
    )
    try {
      await expect(connection.request('test/slow', {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(
        ZcodeAppServerTimeoutError
      )
      // The queue-bypassing stop still answers after an unrelated timeout.
      await expect(connection.request('session/stop', { sessionId: 's' })).resolves.toEqual({})
    } finally {
      expect(await connection.close()).toBe(true)
    }
  })

  it('reports an unexpected child exit once', async () => {
    const children: FakeChild[] = []
    const exits: { expected: boolean }[] = []
    const connection = await openZcodeAppServerConnection(
      { command: 'zcode', args: ['app-server', '--stdio'] },
      { onExit: (_error, exit) => exits.push({ expected: exit?.expected ?? false }) },
      fakeSpawn(children)
    )
    // The stub never exits on its own; the test plays the OS.
    children[0]!.emit('exit', 0, null)
    await vi.waitFor(() => expect(exits).toEqual([{ expected: false }]))
    expect(await connection.close()).toBe(true)
  })

  it('treats a non-JSON stdout line as an unhandled frame, not a crash', async () => {
    const children: FakeChild[] = []
    const unhandled: string[] = []
    const connection = await openZcodeAppServerConnection(
      { command: 'zcode', args: ['app-server', '--stdio'] },
      { onUnhandledFrame: (kind) => unhandled.push(kind) },
      fakeSpawn(children)
    )
    children[0]!.stdout.write('not json at all\n')
    await vi.waitFor(() => expect(unhandled).toEqual(['frame:invalid-json']))
    // The stub has no OS process for the close ladder to reap; play its exit.
    children[0]!.emit('exit', 0, null)
    expect(await connection.close()).toBe(true)
  })
})
