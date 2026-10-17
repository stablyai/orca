import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DAP_MAX_HEADER_BYTES,
  DAP_MAX_MESSAGE_BYTES,
  DapConnection,
  DapConnectionClosedError,
  DapRequestTimeoutError,
  DapResponseError,
  type DapConnectionOptions
} from './dap-connection'
import type { Event, Response } from './dap-protocol'
import {
  DLV_READY_PATTERN,
  JS_DEBUG_READY_PATTERN,
  StderrRing,
  buildAdapterEnv,
  connectSocketAdapter,
  connectTcpAdapter,
  spawnSocketAdapter,
  spawnStdioAdapter,
  spawnTcpAdapter,
  type DapTransport
} from './dap-transport'

const FAKE = join(__dirname, 'dap-adapter-fake.mjs')
const NODE = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
const live: DapConnection[] = []

afterEach(async () => {
  await Promise.all(live.splice(0).map((connection) => connection.close()))
})

function track(transport: DapTransport, options?: DapConnectionOptions): DapConnection {
  const connection = new DapConnection(transport, options)
  live.push(connection)
  return connection
}

function stdio(flags: string[] = [], options?: DapConnectionOptions): DapConnection {
  return track(spawnStdioAdapter({ program: NODE, args: [FAKE, ...flags] }), options)
}

async function tcp(flags: string[] = [], options?: DapConnectionOptions): Promise<DapConnection> {
  const transport = await spawnTcpAdapter(
    { program: NODE, args: [FAKE, '--tcp', '0', ...flags] },
    JS_DEBUG_READY_PATTERN
  )
  return track(transport, options)
}

function nextEvent(connection: DapConnection, name: string): Promise<Event> {
  return new Promise((resolve) => {
    const off = connection.onEvent((event) => {
      if (event.event === name) {
        off()
        resolve(event)
      }
    })
  })
}

function closeReason(connection: DapConnection): Promise<string> {
  return new Promise((resolve) => connection.onClose(resolve))
}

function body(response: Response): Record<string, unknown> {
  expect(response.body).toBeTypeOf('object')
  return Object(response.body)
}

function frame(message: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload])
}

/** In-memory transport: `fromAdapter` is what the adapter writes, `sent` collects what the client wrote. */
function memory(): {
  connection: DapConnection
  fromAdapter: PassThrough
  sent: () => unknown[]
} {
  const fromAdapter = new PassThrough()
  const toAdapter = new PassThrough()
  const written: Buffer[] = []
  toAdapter.on('data', (chunk: Buffer) => written.push(chunk))
  const transport: DapTransport = {
    kind: 'stdio',
    input: fromAdapter,
    output: toAdapter,
    child: null,
    socket: null,
    endpoint: null,
    stderr: new StderrRing()
  }
  const sent = (): unknown[] =>
    Buffer.concat(written)
      .toString('utf8')
      .split(/Content-Length: \d+\r\n\r\n/)
      .filter(Boolean)
      .map((text) => JSON.parse(text))
  return { connection: track(transport), fromAdapter, sent }
}

const initialize = (connection: DapConnection): Promise<Response> =>
  connection.request('initialize', { adapterID: 'fake', linesStartAt1: true })

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('DapConnection framing', () => {
  it('round-trips initialize over stdio and delivers the initialized event', async () => {
    const connection = stdio()
    const initialized = nextEvent(connection, 'initialized')
    const response = await initialize(connection)
    expect(body(response).supportsConfigurationDoneRequest).toBe(true)
    expect(body(response).exceptionBreakpointFilters).toHaveLength(2)
    await initialized
  })

  it('reassembles frames the adapter split into small delayed pieces', async () => {
    const connection = stdio(['--split-writes'])
    const initialized = nextEvent(connection, 'initialized')
    expect(body(await initialize(connection)).supportsTerminateRequest).toBe(true)
    await initialized
  })

  it('separates frames the adapter coalesced into one write', async () => {
    const connection = stdio(['--coalesce'])
    const outputs: string[] = []
    connection.onEvent(
      (event) => event.event === 'output' && outputs.push(String(Object(event.body).output))
    )
    expect(body(await connection.request('fake/burst', { count: 5 })).count).toBe(5)
    expect(outputs).toEqual(['burst 0\n', 'burst 1\n', 'burst 2\n', 'burst 3\n', 'burst 4\n'])
  })

  it('handles a frame delivered byte by byte and two and a half frames in one chunk', async () => {
    const { connection, fromAdapter } = memory()
    const events: string[] = []
    connection.onEvent((event) => events.push(event.event))
    for (const byte of frame({ seq: 1, type: 'event', event: 'one' })) {
      fromAdapter.write(Buffer.from([byte]))
    }
    const two = frame({ seq: 2, type: 'event', event: 'two' })
    const three = frame({ seq: 3, type: 'event', event: 'three' })
    const four = frame({ seq: 4, type: 'event', event: 'four' })
    fromAdapter.write(Buffer.concat([two, three, four.subarray(0, 10)]))
    fromAdapter.write(four.subarray(10))
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual(['one', 'two', 'three', 'four'])
  })

  it('numbers requests with an increasing seq and matches responses on request_seq, not seq', async () => {
    const { connection, fromAdapter, sent } = memory()
    const threads = connection.request('threads')
    const stack = connection.request('stackTrace', { threadId: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    const [first, second] = sent().map((message) => Object(message))
    expect([first.seq, second.seq]).toEqual([1, 2])
    // Each answer's own seq is the OTHER request's seq: only request_seq keying wakes the right waiter.
    fromAdapter.write(
      frame({
        seq: 1,
        type: 'response',
        request_seq: 2,
        success: true,
        command: 'stackTrace',
        body: { stackFrames: [] }
      })
    )
    fromAdapter.write(
      frame({
        seq: 2,
        type: 'response',
        request_seq: 1,
        success: true,
        command: 'threads',
        body: { threads: [] }
      })
    )
    expect((await threads).command).toBe('threads')
    expect((await stack).command).toBe('stackTrace')
  })
})

describe('DapConnection caps and failures', () => {
  it('closes with a reason on a header past 8 KiB', async () => {
    const { connection, fromAdapter } = memory()
    const reason = closeReason(connection)
    fromAdapter.write(Buffer.alloc(DAP_MAX_HEADER_BYTES + 1, 'a'))
    expect(await reason).toMatch(/header longer than 8 KiB/)
  })

  it('closes with a reason on a body past 64 MiB, before reading it', async () => {
    const { connection, fromAdapter } = memory()
    const reason = closeReason(connection)
    fromAdapter.write(`Content-Length: ${DAP_MAX_MESSAGE_BYTES + 1}\r\n\r\n`)
    expect(await reason).toMatch(new RegExp(`Content-Length ${DAP_MAX_MESSAGE_BYTES + 1}`))
  })

  it('closes and rejects the pending request when the real adapter sends an oversized or malformed frame', async () => {
    for (const [flag, pattern] of [
      ['--oversized-frame', /Content-Length 67108865/],
      ['--malformed-frame', /no Content-Length/]
    ] as const) {
      const connection = stdio([flag])
      const reason = closeReason(connection)
      await expect(initialize(connection)).rejects.toBeInstanceOf(DapConnectionClosedError)
      expect(await reason).toMatch(pattern)
    }
  })

  it('times a request out without closing the connection', async () => {
    const connection = stdio(['--silent'])
    await expect(connection.request('initialize', {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(
      DapRequestTimeoutError
    )
    expect(connection.closed).toBe(false)
    expect((await connection.request('threads')).success).toBe(true)
  })

  it('rejects every pending request on close', async () => {
    const connection = stdio(['--silent'])
    const pending = [initialize(connection), initialize(connection)].map((request) =>
      expect(request).rejects.toBeInstanceOf(DapConnectionClosedError)
    )
    await connection.close()
    await Promise.all(pending)
    await expect(connection.request('threads')).rejects.toBeInstanceOf(DapConnectionClosedError)
  })

  it('rejects a success:false response with the adapter message', async () => {
    const connection = stdio()
    const error = await connection.request('bogus').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DapResponseError)
    expect(String(error)).toMatch(/bogus failed: unknown command bogus/)
  })

  it('closes at once, rejecting the pending request, on a JSON frame that is not a valid DAP envelope', async () => {
    for (const [message, pattern] of [
      [{ seq: 1, type: 'bogus' }, /unknown type "bogus"/],
      [{ seq: 1, type: 'response', command: 'initialize', success: true }, /without request_seq/],
      [{ seq: 1, type: 'event', body: {} }, /event without an event name/],
      [{ seq: 1, type: 'request', arguments: {} }, /request without a command/]
    ] as const) {
      const { connection, fromAdapter } = memory()
      const pending = initialize(connection).catch((error: unknown) => error)
      const reason = closeReason(connection)
      fromAdapter.write(frame(message))
      expect(await pending).toBeInstanceOf(DapConnectionClosedError)
      expect(await reason).toMatch(pattern)
    }
  })

  it('runs every close listener even when one throws, and never throws out of close()', async () => {
    const { connection } = memory()
    const seen: string[] = []
    connection.onClose(() => {
      throw new Error('listener bug')
    })
    connection.onClose((reason) => seen.push(reason))
    expect(() => void connection.close('done')).not.toThrow()
    expect(seen).toEqual(['done'])
  })

  it('reads a 63 MiB frame arriving in 16 KiB chunks in linear time', async () => {
    const { connection, fromAdapter } = memory()
    const output = 'x'.repeat(63 * 1024 * 1024)
    const bytes = frame({ seq: 1, type: 'event', event: 'output', body: { output } })
    const got = nextEvent(connection, 'output')
    const started = Date.now()
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      fromAdapter.write(bytes.subarray(offset, offset + 16 * 1024))
    }
    expect(Object((await got).body).output).toHaveLength(output.length)
    // Re-concatenating per chunk copies ~125 GiB here and takes far longer.
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('names the exit and the stderr tail when the adapter dies', async () => {
    const connection = stdio()
    const reason = closeReason(connection)
    await connection.request('fake/crash')
    expect(await reason).toMatch(/adapter exited with 3: fake adapter crashed: boom/)
  })
})

describe('DapConnection events and reverse requests', () => {
  it('drives the scripted program: stop on a breakpoint, inspect, evaluate, run to the end', async () => {
    const connection = stdio(['--frame-zero'])
    const stopped = nextEvent(connection, 'stopped')
    await initialize(connection)
    await connection.request('launch', { program: '/work/app.js' })
    const set = await connection.request('setBreakpoints', {
      source: { path: '/work/app.js' },
      breakpoints: [{ line: 5 }]
    })
    expect(body(set).breakpoints).toEqual([expect.objectContaining({ verified: true, line: 5 })])
    await connection.request('configurationDone')
    expect(Object((await stopped).body)).toMatchObject({
      reason: 'breakpoint',
      threadId: 1
    })
    expect(body(await connection.request('threads')).threads).toEqual([{ id: 1, name: 'main' }])
    const stack = body(await connection.request('stackTrace', { threadId: 1 }))
    expect(stack.stackFrames).toEqual([
      expect.objectContaining({ id: 0, line: 5 }),
      expect.anything()
    ])
    const scopes = body(await connection.request('scopes', { frameId: 0 }))
    expect(scopes.scopes).toEqual([
      expect.objectContaining({ name: 'Locals', variablesReference: 100 })
    ])
    const variables = body(await connection.request('variables', { variablesReference: 100 }))
    expect(variables.variables).toContainEqual(expect.objectContaining({ name: 'a', value: '1' }))
    // Frame 0 must reach the adapter, not be dropped as "no frame".
    expect(body(await connection.request('evaluate', { expression: 'a', frameId: 0 })).result).toBe(
      'a@0'
    )
    const terminated = nextEvent(connection, 'terminated')
    await connection.request('continue', { threadId: 1 })
    await terminated
  })

  it('answers a reverse request with success:false when no handler is installed', async () => {
    const connection = stdio()
    const answer = Object(
      body(
        await connection.request('fake/reverse', {
          command: 'runInTerminal',
          arguments: { args: ['node'] }
        })
      ).response
    )
    expect(answer).toMatchObject({
      type: 'response',
      command: 'runInTerminal',
      success: false,
      message: 'not supported'
    })
    expect(answer.request_seq).toBeTypeOf('number')
  })

  it('answers a handled reverse request with the handler body, and a throw with its message', async () => {
    const connection = stdio([], {
      onReverseRequest: async (request) => {
        if (request.command === 'runInTerminal') {
          return { processId: 42 }
        }
        throw new Error(`declined ${request.command}`)
      }
    })
    const ask = async (command: string): Promise<Record<string, unknown>> =>
      Object(body(await connection.request('fake/reverse', { command, arguments: {} })).response)
    expect(await ask('runInTerminal')).toMatchObject({
      success: true,
      body: { processId: 42 }
    })
    expect(await ask('startDebugging')).toMatchObject({
      success: false,
      message: 'declined startDebugging'
    })
  })
})

describe('DapConnection transports', () => {
  it('parses both listening lines, including bracketed IPv6', () => {
    expect(
      JS_DEBUG_READY_PATTERN.exec('Debug server listening at 127.0.0.1:53211')?.slice(1)
    ).toEqual(['127.0.0.1', '53211'])
    expect(DLV_READY_PATTERN.exec('DAP server listening at: [::1]:4711')?.slice(1)).toEqual([
      '::1',
      '4711'
    ])
    expect(DLV_READY_PATTERN.exec('DAP server listening at: ::1:4711')?.slice(1)).toEqual([
      '::1',
      '4711'
    ])
  })

  it('dials the fake over TCP and serves a js-debug child session on a second connection', async () => {
    const starts: unknown[] = []
    const transport = await spawnTcpAdapter(
      { program: NODE, args: [FAKE, '--tcp', '0', '--js-debug-children'] },
      JS_DEBUG_READY_PATTERN
    )
    const root = track(transport, {
      onReverseRequest: (request) => void starts.push(request.arguments)
    })
    await initialize(root)
    await root.request('launch', { program: '/work/app.js' })
    await root.request('configurationDone')
    await expect.poll(() => starts.length).toBe(1)
    expect(starts[0]).toMatchObject({
      request: 'launch',
      configuration: { __pendingTargetId: 'fake-target-1' }
    })
    const child = track(await connectTcpAdapter({ port: Number(transport.socket?.remotePort) }))
    await initialize(child)
    const set = await child.request('setBreakpoints', {
      source: { path: '/work/app.js' },
      breakpoints: [{ line: 3 }]
    })
    expect(body(set).breakpoints).toEqual([
      { id: 1, verified: false, message: 'breakpoint.provisionalBreakpoint' }
    ])
    const messages: unknown[] = [body(await child.request('fake/received')).messages].flat()
    const carriers = messages
      .map(Object)
      .filter((entry) => Object(entry.message).command === 'setBreakpoints')
    expect(carriers.map((entry) => entry.connection)).toEqual([1])
  })

  it('refuses a non-loopback host, whether passed in or announced by the adapter', async () => {
    await expect(connectTcpAdapter({ host: '10.1.2.3', port: 4711 })).rejects.toThrow(
      /non-loopback/
    )
    await expect(tcp(['--announce-host', '192.168.1.20'])).rejects.toThrow(/non-loopback/)
  })

  it('retries the dial until the announced listener exists', async () => {
    const started = Date.now()
    const connection = await tcp(['--listen-delay', '600'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(500)
    expect((await initialize(connection)).success).toBe(true)
  })

  it('keeps draining adapter stdout after the listening line', async () => {
    // The fake only listens once 8 MiB of stdout has been read; an undrained pipe never gets there.
    // Why the long deadline: 8 MiB through a pipe on a loaded CI box can outlast the 10 s default.
    const transport = await spawnTcpAdapter(
      { program: NODE, args: [FAKE, '--tcp', '0', '--stdout-flood', String(8 * 1024 * 1024)] },
      JS_DEBUG_READY_PATTERN,
      { deadlineMs: 60_000 }
    )
    expect((await initialize(track(transport))).success).toBe(true)
  }, 90_000)

  it('never lets a caller put a loader variable into the adapter env', () => {
    const extra = {
      ADAPTER_EXTRA: '1',
      NODE_OPTIONS: '--require /repo/x.js',
      PYTHONPATH: '/repo',
      PYTHONSTARTUP: '/repo/s.py',
      PYTHONHOME: '/repo',
      LD_PRELOAD: '/repo/x.so',
      DYLD_INSERT_LIBRARIES: '/repo/x.dylib',
      DYLD_LIBRARY_PATH: '/repo'
    }
    expect(buildAdapterEnv(extra, { PATH: '/bin' }, 'darwin')).toEqual({
      PATH: '/bin',
      ADAPTER_EXTRA: '1'
    })
  })

  it('handles an error on the adapter stdout and stderr pipes instead of crashing main', () => {
    const transport = spawnStdioAdapter({ program: NODE, args: [FAKE] })
    track(transport)
    const child = transport.child!
    expect(() => child.stderr.emit('error', new Error('EPIPE'))).not.toThrow()
    const bare = spawnStdioAdapter({ program: NODE, args: [FAKE] })
    expect(() => bare.child!.stdout.emit('error', new Error('ECONNRESET'))).not.toThrow()
    bare.child!.kill('SIGKILL')
  })

  it.skipIf(process.platform === 'win32')(
    'serves js-debug on a unix socket in a 0700 directory, dials the child there, and removes it on close',
    async () => {
      const transport = await spawnSocketAdapter({
        program: NODE,
        args: [FAKE, '--socket', '<socket>', '--js-debug-children']
      })
      const endpoint = transport.endpoint
      expect(transport.kind).toBe('socket')
      if (!endpoint || !('path' in endpoint)) {
        throw new Error('expected a socket endpoint')
      }
      expect(statSync(dirname(endpoint.path)).mode & 0o777).toBe(0o700)
      const root = track(transport, { onReverseRequest: () => ({}) })
      await initialize(root)
      const child = track(await connectSocketAdapter({ path: endpoint.path }))
      await initialize(child)
      const received = [body(await child.request('fake/received')).messages].flat().map(Object)
      expect(received.map((entry) => entry.connection)).toEqual([0, 1])
      await root.close()
      expect(existsSync(dirname(endpoint.path))).toBe(false)
      // Quit's synchronous kill removes the directory too; nothing async runs after it.
      const quitting = await spawnSocketAdapter({
        program: NODE,
        args: [FAKE, '--socket', '<socket>']
      })
      const quitPath = Object(quitting.endpoint).path
      new DapConnection(quitting).killSync()
      expect(existsSync(dirname(quitPath))).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'killSync SIGKILLs the adapter process group at once, with no polite shutdown',
    async () => {
      const connection = stdio(['--grandchild-holds-stderr', '--ignore-sigterm'])
      const pids = body(await connection.request('fake/pids'))
      const [pid, grandchildPid] = [Number(pids.pid), Number(pids.grandchildPid)]
      connection.killSync()
      await expect.poll(() => isAlive(pid) || isAlive(grandchildPid), { timeout: 1000 }).toBe(false)
    }
  )

  it('spawns with an allowlisted environment, never main’s full one', async () => {
    process.env.ORCA_DAP_TEST_SECRET = 'leaked'
    try {
      const connection = track(
        spawnStdioAdapter({
          program: NODE,
          args: [FAKE],
          env: { ADAPTER_EXTRA: '1' }
        })
      )
      const env = Object(body(await connection.request('fake/env')).env)
      const allowed =
        /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_.*|ADAPTER_EXTRA|__CF_USER_TEXT_ENCODING)$/
      const windows =
        /^(SystemRoot|windir|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i
      expect(
        Object.keys(env).filter(
          (name) => !allowed.test(name) && !(process.platform === 'win32' && windows.test(name))
        )
      ).toEqual([])
      expect(env.ADAPTER_EXTRA).toBe('1')
      expect(env.ORCA_DAP_TEST_SECRET).toBeUndefined()
    } finally {
      delete process.env.ORCA_DAP_TEST_SECRET
    }
  })

  it.skipIf(process.platform === 'win32')(
    'close() returns within 3 s while a grandchild holds stderr, and kills the process group',
    async () => {
      const connection = stdio(['--grandchild-holds-stderr', '--ignore-sigterm'], {
        closeTimeoutMs: 500
      })
      const pids = body(await connection.request('fake/pids'))
      const [pid, grandchildPid] = [Number(pids.pid), Number(pids.grandchildPid)]
      expect(isAlive(grandchildPid)).toBe(true)
      const started = Date.now()
      await connection.close()
      expect(Date.now() - started).toBeLessThan(3000)
      await expect.poll(() => isAlive(pid) || isAlive(grandchildPid), { timeout: 2000 }).toBe(false)
    }
  )
})
