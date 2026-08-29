import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import {
  isCodexAppServerRequestError,
  openCodexAppServerConnection,
  type CodexAppServerConnection,
  type CodexAppServerConnectionHandlers
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  vi.useRealTimers()
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
})

/**
 * A real `node -e` child speaking the same JSONL framing Codex does. Slower than
 * a stub, but it is the only thing that proves the spawn, the environment, and
 * both traffic directions actually work end to end.
 */
const FAKE_APP_SERVER = String.raw`
  const readline = require('node:readline')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') return send({ id: message.id, result: {} })
    if (message.method === 'test/env') {
      return send({ id: message.id, result: { codexHome: process.env.CODEX_HOME ?? null } })
    }
    if (message.method === 'test/cwd') {
      return send({ id: message.id, result: { cwd: process.cwd() } })
    }
    if (message.method === 'test/notify') {
      send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-7' } } })
      return send({ id: message.id, result: {} })
    }
    if (message.method === 'test/ask') {
      return send({ id: 99, method: 'item/fileChange/requestApproval', params: { itemId: 'i1' } })
    }
    if (message.method === 'test/refuse') {
      return send({ id: message.id, error: { code: -32602, message: 'bad params' } })
    }
    if (message.method === 'test/missing') {
      return send({ id: message.id, error: { code: -32601, message: 'method not found' } })
    }
    if (message.id === 99) {
      return send({ method: 'test/answered', params: message })
    }
  })
`

async function openFakeServer(
  handlers: CodexAppServerConnectionHandlers = {},
  env?: Record<string, string>,
  envToDelete?: string[],
  cwd?: string
): Promise<CodexAppServerConnection> {
  return openCodexAppServerConnection(
    { command: process.execPath, args: ['-e', FAKE_APP_SERVER], env, envToDelete, cwd },
    handlers
  )
}

type StubChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  pid: number
  kill: ReturnType<typeof vi.fn>
}

/** Full control over framing and death, which a real child cannot give. */
function stubChild(options: { exitOnStdinEnd?: boolean } = {}): {
  child: StubChild
  spawnImpl: typeof spawnProcess
  written: Record<string, unknown>[]
} {
  const child = new EventEmitter() as StubChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  // Keep the synthetic pid outside any real process table so teardown never
  // mistakes an unrelated process for this stub.
  child.pid = 9_999_999
  child.kill = vi.fn()
  const written: Record<string, unknown>[] = []
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) {
        written.push(JSON.parse(line) as Record<string, unknown>)
      }
    }
  })
  if (options.exitOnStdinEnd !== false) {
    child.stdin.on('finish', () => child.emit('exit', 0, null))
  }
  return { child, spawnImpl: (() => child) as unknown as typeof spawnProcess, written }
}

/** Answers the handshake so `openCodexAppServerConnection` can resolve. */
function answerInitialize(child: StubChild): void {
  child.stdin.once('data', () => {
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
  })
}

/** Stream writes land a tick later, so the stderr tail is only complete here. */
async function flushStreams(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject')
    },
    (error: Error) => error
  )
}

describe('openCodexAppServerConnection', () => {
  it('advertises the experimental API required for rollout-path resume', async () => {
    const { child, spawnImpl, written } = stubChild()
    answerInitialize(child)

    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    )

    expect(written[0]).toMatchObject({
      method: 'initialize',
      params: { capabilities: { experimentalApi: true } }
    })
    await connection.close()
  })

  it('completes the handshake and keeps the child alive across calls', async () => {
    const notifications: { method: string; params: unknown }[] = []
    const connection = await openFakeServer({
      onNotification: (method, params) => notifications.push({ method, params })
    })

    await connection.request('test/notify')
    await connection.request('test/notify')

    expect(connection.pid).toBeGreaterThan(0)
    expect(connection.closed).toBe(false)
    expect(notifications).toHaveLength(2)
    expect(notifications[0]).toEqual({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-7' } }
    })
    await connection.close()
    expect(connection.closed).toBe(true)
  })

  it('applies the environment overlay after stripping inherited keys', async () => {
    process.env.CODEX_HOME = '/tmp/inherited-home'
    const pinned = await openFakeServer({}, { CODEX_HOME: '/tmp/pinned-home' })
    expect(await pinned.request('test/env')).toEqual({ codexHome: '/tmp/pinned-home' })
    await pinned.close()

    const stripped = await openFakeServer({}, undefined, ['CODEX_HOME'])
    expect(await stripped.request('test/env')).toEqual({ codexHome: null })
    await stripped.close()
  })

  it('starts the provider in the resolved workspace directory', async () => {
    const workspace = realpathSync(tmpdir())
    const connection = await openFakeServer({}, undefined, undefined, workspace)

    await expect(connection.request('test/cwd')).resolves.toEqual({ cwd: workspace })
    await connection.close()
  })

  it('routes a server request to the handler and writes the reply back', async () => {
    const requests: { id: number | string; method: string }[] = []
    let resolveAnswered: (params: unknown) => void = () => {}
    const answered = new Promise<unknown>((resolve) => {
      resolveAnswered = resolve
    })
    const connection = await openFakeServer({
      onServerRequest: (request) => {
        requests.push({ id: request.id, method: request.method })
        connection.respond(request.id, { decision: 'accept' })
      },
      onNotification: (method, params) => {
        if (method === 'test/answered') {
          resolveAnswered(params)
        }
      }
    })

    connection.notify('test/ask')

    expect(await answered).toEqual({ id: 99, result: { decision: 'accept' } })
    expect(requests).toEqual([{ id: 99, method: 'item/fileChange/requestApproval' }])
    await connection.close()
  })

  it('classifies a refusal apart from a missing method', async () => {
    const connection = await openFakeServer()

    const refusal = await connection.request('test/refuse').catch((error: unknown) => error)
    const missing = await connection.request('test/missing').catch((error: unknown) => error)

    expect(isCodexAppServerRequestError(refusal)).toBe(true)
    expect((refusal as Error).message).toContain('bad params')
    expect(isCodexAppServerUnsupportedError(missing)).toBe(true)
    expect(isCodexAppServerRequestError(missing)).toBe(false)
    await connection.close()
  })

  it('reassembles a message split mid-character across chunks', async () => {
    const { child, spawnImpl } = stubChild()
    answerInitialize(child)
    const notifications: unknown[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onNotification: (_method, params) => notifications.push(params) },
      spawnImpl
    )

    const payload = Buffer.from(
      `${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '日本語' } })}\n`,
      'utf8'
    )
    const split = payload.indexOf(Buffer.from('日', 'utf8')) + 1
    child.stdout.write(payload.subarray(0, split))
    child.stdout.write(payload.subarray(split))
    await vi.waitFor(() => expect(notifications).toHaveLength(1))

    expect(notifications[0]).toEqual({ delta: '日本語' })
    await connection.close()
  })

  it('surfaces valid but unclassified frames instead of dropping them', async () => {
    const { child, spawnImpl } = stubChild()
    answerInitialize(child)
    const frames: { kind: string; payload: unknown }[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onUnhandledFrame: (kind, payload) => frames.push({ kind, payload }) },
      spawnImpl
    )

    child.stdout.write(`${JSON.stringify({ id: 'late-string-id', result: { value: 1 } })}\n`)
    child.stdout.write(`${JSON.stringify({ id: 999, result: { value: 2 } })}\n`)
    await vi.waitFor(() => expect(frames).toHaveLength(2))

    expect(frames.map((frame) => frame.kind)).toEqual(['frame:unclassified', 'response:unmatched'])
    await connection.close()
  })

  it('fails in-flight requests and reports an unexpected exit once', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )

    const inFlight = rejection(connection.request('turn/start'))
    child.stderr.write('codex crashed\n')
    await flushStreams()
    child.emit('exit', 1, null)
    child.emit('close', 1, null)

    expect((await inFlight).message).toContain('codex crashed')
    expect(exits).toHaveLength(1)
    await connection.close()
  })

  it('classifies a CLI without the app-server subcommand as unsupported', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    const opening = openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    ).catch((error: unknown) => error)

    child.stderr.write("error: unrecognized subcommand 'app-server'\n")
    await flushStreams()
    child.emit('exit', 2, null)
    child.emit('close', 2, null)

    expect(isCodexAppServerUnsupportedError(await opening)).toBe(true)
  })

  it('exposes an unproven handshake child for later cleanup', async () => {
    vi.useFakeTimers()
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    child.stdin.once('data', () => {
      child.stdout.write(
        `${JSON.stringify({ id: 1, error: { code: -32602, message: 'initialize failed' } })}\n`
      )
    })
    const opening = rejection(
      openCodexAppServerConnection({ command: 'codex', args: ['app-server'] }, {}, spawnImpl)
    )

    await vi.advanceTimersByTimeAsync(5_000)
    const error = (await opening) as Error & { connection?: CodexAppServerConnection }

    expect(error.name).toBe('CodexAppServerHandshakeExitUnprovenError')
    expect(error.connection).toBeDefined()
    child.emit('close', 1, null)
    await expect(error.connection?.close()).resolves.toBe(true)
  })

  it('times out one request without ending the connection', async () => {
    vi.useFakeTimers()
    const { child, spawnImpl } = stubChild()
    answerInitialize(child)
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    )

    const slow = rejection(connection.request('turn/start', undefined, { timeoutMs: 50 }))
    await vi.advanceTimersByTimeAsync(60)

    expect((await slow).name).toBe('CodexAppServerTimeoutError')
    expect(connection.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
  })

  it('kills a child that ignores stdin EOF', async () => {
    vi.useFakeTimers()
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    )
    child.kill.mockImplementation(() => {
      child.emit('exit', null, 'SIGKILL')
      return true
    })

    const closing = connection.close()
    await vi.advanceTimersByTimeAsync(2_000)
    await closing

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
  })

  it('reports unproven close when forced termination did not produce an exit event', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    )

    await expect(connection.close()).resolves.toBe(false)
  }, 10_000)

  it('shares one eventual exit proof across concurrent close callers', async () => {
    vi.useFakeTimers()
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    )
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit('exit', null, 'SIGKILL'), 10)
      return true
    })

    const first = connection.close()
    const second = connection.close()
    await vi.advanceTimersByTimeAsync(4_100)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGSTOP', 'SIGKILL'])
  })

  it('allows a later close to observe exit after an unproven attempt', async () => {
    vi.useFakeTimers()
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    )

    const first = connection.close()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(first).resolves.toBe(false)
    child.emit('exit', 0, null)

    await expect(connection.close()).resolves.toBe(true)
  })

  it('ends the connection rather than buffering an oversized line', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )
    child.kill.mockImplementation(() => {
      child.emit('exit', null, 'SIGKILL')
      return true
    })

    const inFlight = rejection(connection.request('turn/start'))
    child.stdout.write('x'.repeat(1024 * 1024 + 1))

    expect((await inFlight).message).toContain('oversized')
    expect(exits[0]).toContain('oversized')
    await connection.close()
  })

  it.each([
    {
      kind: 'notification',
      frame: { method: 'turn/started', params: { turn: { id: 'turn-1' } } }
    },
    {
      kind: 'server request',
      frame: { id: 41, method: 'item/fileChange/requestApproval', params: { itemId: 'item-1' } }
    }
  ])('surfaces a synchronous $kind handler failure as a terminal exit', async ({ frame }) => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const exits: string[] = []
    const fail = (): never => {
      throw new Error('structured sink failed')
    }
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {
        onNotification: fail,
        onServerRequest: fail,
        onExit: (error) => exits.push(error.message)
      },
      spawnImpl
    )
    child.kill.mockImplementation(() => {
      child.emit('exit', null, 'SIGKILL')
      return true
    })

    const inFlight = rejection(connection.request('turn/start'))
    child.stdout.write(`${JSON.stringify(frame)}\n`)

    expect((await inFlight).message).toContain('structured sink failed')
    expect(exits).toEqual([expect.stringContaining('structured sink failed')])
    expect(connection.closed).toBe(true)
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
    await connection.close()
  })

  it('reports one exit for a death that arrives through two listeners', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )

    // The oversized line kills the child, so its own `close` lands afterwards.
    child.stdout.write('x'.repeat(1024 * 1024 + 1))
    child.stderr.write('killed\n')
    await flushStreams()
    child.emit('exit', null, 'SIGKILL')
    child.emit('close', null, 'SIGKILL')

    expect(exits).toHaveLength(1)
    // The first cause survives; the generic exit that follows does not overwrite it.
    expect(exits[0]).toContain('oversized')
    await connection.close()
  })

  it('treats a broken stdin pipe as the end of the transport', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )
    child.kill.mockImplementation(() => {
      child.emit('exit', null, 'SIGKILL')
      return true
    })

    const inFlight = rejection(connection.request('turn/start'))
    child.stdin.emit('error', new Error('write EPIPE'))

    expect((await inFlight).message).toContain('EPIPE')
    expect(exits).toHaveLength(1)
    // A child nobody can write to is not a live session: the owner must see the
    // connection as gone rather than keep issuing calls that can only time out.
    expect(connection.closed).toBe(true)
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
    expect((await rejection(connection.request('turn/start'))).message).toContain('EPIPE')
    await connection.close()
  })

  it('keeps a graceful close quiet when stdin breaks during the reap', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )
    child.stdin.on('finish', () => child.stdin.emit('error', new Error('write EPIPE')))
    child.kill.mockImplementation(() => {
      child.emit('exit', null, 'SIGKILL')
      return true
    })

    const inFlight = rejection(connection.request('turn/start'))
    await connection.close()

    expect((await inFlight).message).toContain('EPIPE')
    expect(exits).toHaveLength(0)
  })
})
