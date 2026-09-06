import { EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import {
  CODEX_APP_SERVER_MAX_RECORD_BYTES,
  CodexAppServerFrameSizeError,
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

function commandCompletionFixture(
  targetBytes: number,
  itemId = 'item-large'
): { line: string; output: string } {
  const frame = {
    method: 'item/completed',
    params: {
      turnId: 'turn-large',
      item: { id: itemId, type: 'commandExecution', aggregated_output: '' }
    }
  }
  const emptyBytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
  const remaining = targetBytes - emptyBytes
  if (remaining < 0) {
    throw new Error(`target ${targetBytes} is smaller than fixture envelope ${emptyBytes}`)
  }
  const output = `${'\n'.repeat(Math.floor(remaining / 2))}${remaining % 2 ? 'x' : ''}`
  frame.params.item.aggregated_output = output
  const line = JSON.stringify(frame)
  expect(Buffer.byteLength(line, 'utf8')).toBe(targetBytes)
  return { line: `${line}\n`, output }
}

function commandCompletionLine(targetBytes: number): string {
  return commandCompletionFixture(targetBytes).line
}

function responseLine(targetBytes: number, id: number): string {
  const frame = { id, result: { data: '' } }
  const emptyBytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
  frame.result.data = 'x'.repeat(targetBytes - emptyBytes)
  const line = JSON.stringify(frame)
  expect(Buffer.byteLength(line, 'utf8')).toBe(targetBytes)
  return `${line}\n`
}

function resultFirstResponseLine(targetBytes: number, id: number, resultKey: 'result' | 'error') {
  const response =
    resultKey === 'result'
      ? `{"result":{"turn":{"id":"turn-large"}},"id":${id},"padding":"`
      : `{"error":{"code":-32000,"message":"too large"},"id":${id},"padding":"`
  const suffix = '"}'
  const padding = targetBytes - Buffer.byteLength(response + suffix, 'utf8')
  if (padding < 0) {
    throw new Error(`target ${targetBytes} is smaller than fixture envelope`)
  }
  const line = `${response}${'x'.repeat(padding)}${suffix}`
  expect(Buffer.byteLength(line, 'utf8')).toBe(targetBytes)
  return `${line}\n`
}

function giantContainerBeforeIdResponseLine(targetBytes: number, id: number): string {
  const giantResult = `{"result":{"payload":"${'x'.repeat(62_000)}"},"id":${id},"padding":"`
  const suffix = '"}'
  const padding = targetBytes - Buffer.byteLength(giantResult + suffix, 'utf8')
  if (padding < 0) {
    throw new Error(`target ${targetBytes} is smaller than giant response envelope`)
  }
  return `${giantResult}${'x'.repeat(padding)}${suffix}\n`
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

  it.each([1_090_188, 2_900_090])(
    'accepts a realistic %i-byte escaped command completion and keeps processing',
    async (frameBytes) => {
      const { child, spawnImpl } = stubChild()
      answerInitialize(child)
      const completed: unknown[] = []
      const connection = await openCodexAppServerConnection(
        { command: 'codex', args: ['app-server'] },
        {
          onNotification: (method, params) => {
            if (method === 'item/completed') {
              completed.push(params)
            }
          }
        },
        spawnImpl
      )

      const line = Buffer.from(commandCompletionLine(frameBytes), 'utf8')
      const split = Math.floor(line.length / 3)
      child.stdout.write(line.subarray(0, split))
      child.stdout.write(line.subarray(split, split * 2))
      child.stdout.write(line.subarray(split * 2))
      child.stdout.write('{"method":"turn/completed","params":{"turn":{"id":"turn-large"}}}\n')
      await vi.waitFor(() => expect(completed).toHaveLength(1))

      expect(
        (completed[0] as { item: { aggregated_output: string } }).item.aggregated_output.length
      ).toBeGreaterThan(500_000)
      expect(connection.closed).toBe(false)
      await connection.close()
    }
  )

  it('accepts two realistic large command completions without losing either payload', async () => {
    const { child, spawnImpl } = stubChild()
    answerInitialize(child)
    const completed: { item: { id: string; aggregated_output: string } }[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {
        onNotification: (method, params) => {
          if (method === 'item/completed') {
            completed.push(params as { item: { id: string; aggregated_output: string } })
          }
        }
      },
      spawnImpl
    )
    const fixtures = [
      commandCompletionFixture(1_090_188, 'item-large-a'),
      commandCompletionFixture(2_900_090, 'item-large-b')
    ]

    child.stdout.write(fixtures[0]!.line)
    child.stdout.write(fixtures[1]!.line)
    await vi.waitFor(() => expect(completed).toHaveLength(2))

    expect(completed.map((entry) => entry.item.id)).toEqual(['item-large-a', 'item-large-b'])
    expect(
      completed.map((entry) => Buffer.byteLength(entry.item.aggregated_output, 'utf8'))
    ).toEqual(fixtures.map((fixture) => Buffer.byteLength(fixture.output, 'utf8')))
    expect(connection.closed).toBe(false)
    await connection.close()
  })

  it('accepts the 16 MiB boundary and settles one byte above without killing the provider', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const exits: string[] = []
    const frames: { kind: string; payload: unknown }[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {
        onExit: (error) => exits.push(error.message),
        onUnhandledFrame: (kind, payload) => frames.push({ kind, payload })
      },
      spawnImpl
    )

    const below = connection.request('thread/resume')
    child.stdout.write(responseLine(CODEX_APP_SERVER_MAX_RECORD_BYTES - 1, 2))
    expect(((await below) as { data: string }).data.length).toBeGreaterThan(
      CODEX_APP_SERVER_MAX_RECORD_BYTES - 40
    )

    const at = connection.request('thread/resume')
    child.stdout.write(responseLine(CODEX_APP_SERVER_MAX_RECORD_BYTES, 3))
    expect(((await at) as { data: string }).data.length).toBeGreaterThan(
      CODEX_APP_SERVER_MAX_RECORD_BYTES - 40
    )

    const inFlight = rejection(connection.request('turn/start'))
    child.stdout.write(responseLine(CODEX_APP_SERVER_MAX_RECORD_BYTES + 1, 4))

    expect(await inFlight).toBeInstanceOf(CodexAppServerFrameSizeError)
    expect(frames).toEqual([
      {
        kind: 'frame:oversized-response',
        payload: expect.objectContaining({ classification: 'response', id: 4 })
      }
    ])
    expect(exits).toEqual([])
    expect(connection.closed).toBe(false)

    const later = connection.request('turn/start')
    child.stdout.write('{"id":5,"result":{"turn":{"id":"turn-next"}}}\n')
    await expect(later).resolves.toEqual({ turn: { id: 'turn-next' } })
    child.emit('exit', 0, null)
    await connection.close()
  })

  it.each(['result', 'error'] as const)(
    'classifies oversized responses with %s before id',
    async (resultKey) => {
      const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
      answerInitialize(child)
      const frames: { kind: string; payload: unknown }[] = []
      const connection = await openCodexAppServerConnection(
        { command: 'codex', args: ['app-server'] },
        { onUnhandledFrame: (kind, payload) => frames.push({ kind, payload }) },
        spawnImpl
      )

      const inFlight = rejection(connection.request('thread/resume'))
      child.stdout.write(
        resultFirstResponseLine(CODEX_APP_SERVER_MAX_RECORD_BYTES + 1, 2, resultKey)
      )

      expect(await inFlight).toBeInstanceOf(CodexAppServerFrameSizeError)
      expect(frames).toEqual([
        {
          kind: 'frame:oversized-response',
          payload: expect.objectContaining({ classification: 'response', id: 2 })
        }
      ])
      expect(connection.closed).toBe(false)
      child.emit('exit', 0, null)
      await connection.close()
    }
  )

  it('classifies an oversized response when a giant result container precedes id', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const frames: { kind: string; payload: unknown }[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onUnhandledFrame: (kind, payload) => frames.push({ kind, payload }) },
      spawnImpl
    )

    const inFlight = rejection(connection.request('thread/resume'))
    child.stdout.write(giantContainerBeforeIdResponseLine(CODEX_APP_SERVER_MAX_RECORD_BYTES + 1, 2))

    await expect(inFlight).resolves.toBeInstanceOf(CodexAppServerFrameSizeError)
    expect(frames).toEqual([
      {
        kind: 'frame:oversized-response',
        payload: expect.objectContaining({ classification: 'response', id: 2 })
      }
    ])
    child.emit('exit', 0, null)
    await connection.close()
  })

  it('answers an oversized provider request once and resumes after its newline', async () => {
    const { child, spawnImpl, written } = stubChild()
    answerInitialize(child)
    const frames: string[] = []
    const notifications: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {
        onUnhandledFrame: (kind) => frames.push(kind),
        onNotification: (method) => notifications.push(method)
      },
      spawnImpl
    )

    child.stdout.write(
      `{"id":"approval-1","method":"item/requestApproval","params":{"data":"${'x'.repeat(
        CODEX_APP_SERVER_MAX_RECORD_BYTES
      )}"}}\n{"method":"turn/completed","params":{}}\n`
    )
    await vi.waitFor(() => expect(notifications).toEqual(['turn/completed']))

    expect(frames).toEqual(['frame:oversized-request'])
    expect(written.at(-1)).toEqual({
      id: 'approval-1',
      error: {
        code: -32001,
        message: `request exceeds ${CODEX_APP_SERVER_MAX_RECORD_BYTES} byte limit`
      }
    })
    expect(connection.closed).toBe(false)
    await connection.close()
  })

  it('keeps malformed and non-object JSON non-fatal and processes the next record', async () => {
    const { child, spawnImpl } = stubChild()
    answerInitialize(child)
    const frames: { kind: string; payload: unknown }[] = []
    const notifications: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {
        onUnhandledFrame: (kind, payload) => frames.push({ kind, payload }),
        onNotification: (method) => notifications.push(method)
      },
      spawnImpl
    )

    child.stdout.write('not json\n[]\n{"method":"turn/completed","params":{}}\n')
    await vi.waitFor(() => expect(notifications).toEqual(['turn/completed']))

    expect(frames).toEqual([
      { kind: 'frame:invalid-json', payload: 'not json' },
      { kind: 'frame:invalid-json', payload: '[]' }
    ])
    expect(connection.closed).toBe(false)
    await connection.close()
  })

  it('pauses between coalesced records and resumes the retained remainder', async () => {
    const { child, spawnImpl } = stubChild()
    answerInitialize(child)
    const notifications: string[] = []
    let connection: CodexAppServerConnection
    connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {
        onNotification: (method) => {
          notifications.push(method)
          if (notifications.length === 1) {
            connection.pauseReading?.()
          }
        }
      },
      spawnImpl
    )

    child.stdout.write(
      '{"method":"item/started","params":{}}\n{"method":"item/completed","params":{}}\n'
    )
    await vi.waitFor(() => expect(notifications).toEqual(['item/started']))
    connection.resumeReading?.()
    await vi.waitFor(() => expect(notifications).toEqual(['item/started', 'item/completed']))

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

    // An unclassifiable oversized line initiates recovery, then child exit lands afterwards.
    child.stdout.write('x'.repeat(CODEX_APP_SERVER_MAX_RECORD_BYTES + 1))
    child.stderr.write('killed\n')
    await flushStreams()
    child.emit('exit', null, 'SIGKILL')
    child.emit('close', null, 'SIGKILL')

    expect(exits).toHaveLength(1)
    // The first cause survives; the generic exit that follows does not overwrite it.
    expect(exits[0]).toContain('oversized')
    await connection.close()
  })

  it('does not report recovery for a protocol failure until child exit is observed', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )

    const inFlight = rejection(connection.request('turn/start'))
    child.stdout.write('x'.repeat(CODEX_APP_SERVER_MAX_RECORD_BYTES + 1))
    await flushStreams()

    expect(exits).toHaveLength(0)
    expect((await inFlight).message).toContain('oversized')

    child.emit('exit', null, 'SIGKILL')
    expect(exits).toHaveLength(1)
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
