import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { DAP_ADAPTERS } from './dap-adapter-registry'
import { DapConnection } from './dap-connection'
import { connectTcpAdapter, JS_DEBUG_READY_PATTERN } from './dap-transport'
import { DebugBreakpointStore, normalizeDebugPath } from './debug-breakpoint-store'
import { DebugSession, type DebugSessionState } from './debug-session'
import { SessionBreakpoints } from './debug-session-breakpoints'
import type { DebugAdapterCommand } from './debug-session-handshake'
import type { LaunchSpec } from './launch-config'

const FAKE = join(__dirname, 'dap-adapter-fake.mjs')
const NODE = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

type Received = {
  connection: number
  message: { type: string; command?: string; arguments?: Record<string, unknown> }
}

function row(id: string) {
  const found = DAP_ADAPTERS.find((r) => r.id === id)
  if (!found) {
    throw new Error(id)
  }
  return found
}

function spec(adapterId: string, request: 'launch' | 'attach' = 'launch'): LaunchSpec {
  const config = { type: row(adapterId).wireType, request, name: 'fake', program: '/work/app.py' }
  return {
    adapterId,
    request,
    config,
    resolved: config,
    name: 'fake',
    configHash: 'h',
    runs: Object.create(null)
  }
}

function workspace(): { root: string; file: string; store: DebugBreakpointStore } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-debug-session-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'app.py')
  writeFileSync(file, 'x = 1\n')
  return { root: dir, file, store: new DebugBreakpointStore({ filePath: join(dir, '.bp.json') }) }
}

function makeSession(options: {
  adapter: 'debugpy' | 'js-debug'
  flags?: string[]
  command?: DebugAdapterCommand
  request?: 'launch' | 'attach'
  lines?: number[]
  log?: string[]
}) {
  const ws = workspace()
  for (const line of options.lines ?? [3]) {
    ws.store.add(ws.root, ws.file, { line })
  }
  const tcp = options.adapter === 'js-debug' ? ['--socket', '<socket>', '--js-debug-children'] : []
  const session = new DebugSession({
    spec: spec(options.adapter, options.request),
    command: options.command ?? { program: NODE, args: [FAKE, ...tcp, ...(options.flags ?? [])] },
    worktreeRoot: ws.root,
    breakpoints: ws.store,
    log: (line) => options.log?.push(line)
  })
  cleanups.push(() => session.dispose())
  return { session, ...ws }
}

function waitFor(session: DebugSession, done: (s: DebugSessionState) => boolean, ms = 5000) {
  return new Promise<DebugSessionState>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`state stayed ${JSON.stringify(session.state)}`)),
      ms
    )
    const check = (state: DebugSessionState): void => {
      if (done(state)) {
        clearTimeout(timer)
        off()
        resolve(state)
      }
    }
    const off = session.onStateChange(check)
    check(session.state)
  })
}

async function received(
  session: DebugSession,
  target: 'leaf' | 'root' = 'leaf'
): Promise<Received[]> {
  const response = await session.customRequest('fake/received', undefined, target)
  return Object(response.body).messages
}

const requests = (messages: Received[], connection: number) =>
  messages.filter((m) => m.connection === connection && m.message.type === 'request')
const commands = (messages: Received[], connection: number) =>
  requests(messages, connection).map((m) => m.message.command)

describe('DebugSession on the fake adapter', () => {
  it('completes debugpy order: launch is answered only after configurationDone', async () => {
    const { session, file } = makeSession({
      adapter: 'debugpy',
      flags: ['--launch-reply-after-config-done']
    })
    await session.start()
    const state = await waitFor(session, (s) => s.status === 'stopped')
    expect(state).toMatchObject({
      stoppedReason: 'breakpoint',
      threadId: 1,
      allThreadsStopped: true
    })
    const messages = await received(session)
    expect(commands(messages, 0)).toEqual([
      'initialize',
      'launch',
      'setBreakpoints',
      'setExceptionBreakpoints',
      'configurationDone'
    ])
    const [init, , , exceptions] = requests(messages, 0)
    expect(init.message.arguments).toMatchObject({
      clientID: 'orca',
      adapterID: 'python',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true
    })
    // The adapter's default:true filter, since the user set none.
    expect(exceptions.message.arguments).toEqual({ filters: ['uncaught'] })
    expect(session.breakpointStatus(file)).toEqual([
      expect.objectContaining({ state: 'verified', line: 3, requestedLine: 3 })
    ])
  })

  it('js-debug: root gets only exceptions + configurationDone, the child gets its config verbatim', async () => {
    const { session, file } = makeSession({ adapter: 'js-debug' })
    await session.start()
    expect(await waitFor(session, (s) => s.status === 'stopped')).toMatchObject({
      stoppedReason: 'breakpoint'
    })
    const messages = await received(session)
    expect(commands(messages, 0)).toEqual([
      'initialize',
      'launch',
      'setExceptionBreakpoints',
      'configurationDone'
    ])
    const rootDone = messages.findIndex(
      (m) => m.connection === 0 && m.message.command === 'configurationDone'
    )
    expect(rootDone).toBeLessThan(messages.findIndex((m) => m.connection === 1))
    expect(commands(messages, 1).filter((c) => c !== 'setExceptionBreakpoints')).toEqual([
      'initialize',
      'launch',
      'setBreakpoints',
      'configurationDone'
    ])
    const childLaunch = requests(messages, 1).find((m) => m.message.command === 'launch')
    expect(JSON.stringify(childLaunch?.message.arguments)).toBe(
      JSON.stringify({ type: 'pwa-node', name: 'fake child', __pendingTargetId: 'fake-target-1' })
    )
    const carriers = messages
      .filter((m) => m.message.command === 'setBreakpoints')
      .map((m) => m.connection)
    expect(carriers).toEqual([1])
    // Provisional is pending (will bind), and the fake then hits it.
    expect(session.breakpointStatus(file)).toEqual([
      expect.objectContaining({ state: 'pending', message: 'breakpoint.provisionalBreakpoint' })
    ])
  })

  it('refuses a second startDebugging with success:false and logs the declined configuration', async () => {
    const log: string[] = []
    const { session } = makeSession({ adapter: 'js-debug', log })
    await session.start()
    const configuration = { type: 'pwa-node', name: 'worker target', __pendingTargetId: 't2' }
    const reply = await session.customRequest(
      'fake/reverse',
      { command: 'startDebugging', arguments: { request: 'launch', configuration } },
      'root'
    )
    expect(Object(reply.body).response).toMatchObject({ success: false })
    expect(log.join('\n')).toMatch(/declined.*worker target/)
  })

  it('ignores a js-debug root stopped event; only the leaf drives state', async () => {
    const { session } = makeSession({ adapter: 'js-debug' })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    await session.customRequest('pause', { threadId: 1 }, 'root')
    // The root's stopped event precedes this answer on the same connection.
    await session.customRequest('threads', undefined, 'root')
    expect(session.state).toMatchObject({ status: 'stopped', stoppedReason: 'breakpoint' })
  })

  it('sends frameId 0 to evaluate, and pages variables only when the adapter claims it', async () => {
    const { session } = makeSession({ adapter: 'debugpy', flags: ['--frame-zero'] })
    await session.start()
    const { threadId } = await waitFor(session, (s) => s.status === 'stopped')
    const { stackFrames } = await session.stackTrace(threadId ?? 1)
    expect(stackFrames[0]).toMatchObject({ id: 0, line: 3 })
    expect(await session.evaluate('a', 0)).toMatchObject({ result: 'a@0' })
    expect(await session.evaluate('a')).toMatchObject({ result: 'a@global' })
    const [locals] = await session.scopes(0)
    expect((await session.variables(locals.variablesReference, 0, 10)).map((v) => v.name)).toEqual([
      'a',
      'obj'
    ])
    const sent = requests(await received(session), 0)
    expect(sent.find((m) => m.message.command === 'evaluate')?.message.arguments).toEqual({
      expression: 'a',
      context: 'repl',
      frameId: 0
    })
    expect(sent.find((m) => m.message.command === 'variables')?.message.arguments).toEqual({
      variablesReference: 100
    })
  })

  it('steps and continues to the end, collecting output', async () => {
    const { session } = makeSession({ adapter: 'debugpy', lines: [3, 5] })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    await session.next(1)
    expect(await waitFor(session, (s) => s.status === 'stopped')).toMatchObject({
      stoppedReason: 'step'
    })
    expect((await session.stackTrace(1)).stackFrames[0].line).toBe(4)
    await session.continue(1)
    await waitFor(session, (s) => s.status === 'stopped' && s.stoppedReason === 'breakpoint')
    await session.continue(1)
    await waitFor(session, (s) => s.status === 'terminated')
    expect(session.output().map((o) => o.output)).toEqual([
      'fake program started\n',
      'fake program finished\n'
    ])
  })

  it('stops within 3 s while a grandchild holds stderr', async () => {
    const { session } = makeSession({ adapter: 'debugpy', flags: ['--grandchild-holds-stderr'] })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    const { grandchildPid } = Object((await session.customRequest('fake/pids')).body)
    const started = Date.now()
    await session.stop()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(session.state.status).toBe('terminated')
    await expect
      .poll(() => {
        try {
          process.kill(grandchildPid, 0)
          return 'alive'
        } catch {
          return 'gone'
        }
      })
      .toBe('gone')
  })

  it('turns an adapter crash mid-run into terminated with the stderr tail', async () => {
    const { session } = makeSession({ adapter: 'debugpy' })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    await session.customRequest('fake/crash')
    const state = await waitFor(session, (s) => s.status === 'terminated')
    expect(state.reason).toMatch(/fake adapter crashed: boom/)
  })

  it('re-sends a file to the live session when the store changes', async () => {
    const { session, root, file, store } = makeSession({ adapter: 'js-debug' })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    store.add(root, file, { line: 8 })
    await expect
      .poll(
        async () =>
          requests(await received(session), 1).filter((m) => m.message.command === 'setBreakpoints')
            .length
      )
      .toBe(2)
    const sends = (await received(session)).filter((m) => m.message.command === 'setBreakpoints')
    expect(sends.map((m) => m.connection)).toEqual([1, 1])
    expect(sends[1].message.arguments).toMatchObject({
      source: { path: normalizeDebugPath(file) },
      breakpoints: [{ line: 3 }, { line: 8 }]
    })
  })

  it('stops an attach with disconnect{terminateDebuggee:false} and never terminate', async () => {
    const server = spawnProcess({
      program: NODE,
      args: [FAKE, '--tcp', '0', '--js-debug-children']
    })
    cleanups.push(() => server.kill('SIGKILL'))
    const port = await new Promise<number>((resolve) => {
      let seen = ''
      server.stdout.on('data', (chunk: Buffer) => {
        const match = JS_DEBUG_READY_PATTERN.exec((seen += chunk.toString()))
        if (match) {
          resolve(Number(match[2]))
        }
      })
    })
    const command = { host: '127.0.0.1', port }
    const { session } = makeSession({ adapter: 'js-debug', request: 'attach', command })
    await session.start()
    await session.stop()
    const probe = new DapConnection(await connectTcpAdapter({ port }))
    cleanups.push(() => probe.close())
    const messages: Received[] = Object((await probe.request('fake/received')).body).messages
    const stops = messages.filter(
      (m) => m.message.command === 'disconnect' || m.message.command === 'terminate'
    )
    expect(stops.map((m) => [m.connection, m.message.command, m.message.arguments])).toEqual([
      [1, 'disconnect', { terminateDebuggee: false }],
      [0, 'disconnect', { terminateDebuggee: false }]
    ])
  })

  it('names the root adapter stderr when a js-debug child connection drops mid-run', async () => {
    const { session } = makeSession({ adapter: 'js-debug' })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    await session.customRequest('fake/drop')
    const state = await waitFor(session, (s) => s.status === 'terminated')
    expect(state.reason).toMatch(/fake child dropped: socket gone/)
  })

  it('stops a two-connection session that ignores stop requests within one 3 s deadline', async () => {
    const { session } = makeSession({
      adapter: 'js-debug',
      flags: ['--ignore-stop', '--ignore-sigterm']
    })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    const started = Date.now()
    await session.stop()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(session.state.status).toBe('terminated')
    // stop() returned at its deadline; the closes still run, so do not leave them to outlive the test.
    session.killSync()
  })

  it('killSync SIGKILLs the adapter at once, without a polite shutdown', async () => {
    const { session } = makeSession({ adapter: 'debugpy', flags: ['--ignore-sigterm'] })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    const { pid } = Object((await session.customRequest('fake/pids')).body)
    session.killSync()
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await expect.poll(alive, { timeout: 1000 }).toBe(false)
  })

  it('caps each output entry at 8 KiB and the output ring at 1 MiB', async () => {
    const { session } = makeSession({ adapter: 'debugpy' })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    await session.customRequest('fake/print', { bytes: 20_000 })
    const big = session.output().find((o) => o.output.startsWith('ppp'))
    expect(big?.output).toMatch(/^p{8192}… \[11808 bytes truncated\]\n$/)
    for (let i = 0; i < 150; i++) {
      await session.customRequest('fake/print', { bytes: 8 * 1024 })
    }
    expect(session.outputRing.byteSize).toBeLessThanOrEqual(1024 * 1024)
    expect(session.output().length).toBeLessThan(150)
  })

  it('never puts the launch config env on the adapter process', async () => {
    const ws = workspace()
    const base = spec('debugpy')
    const config = { ...base.config, env: { ORCA_DEBUGGEE_ONLY: '1' } }
    const session = new DebugSession({
      spec: { ...base, config, resolved: config },
      command: { program: NODE, args: [FAKE, '--stop-on-entry'] },
      worktreeRoot: ws.root,
      breakpoints: ws.store
    })
    cleanups.push(() => session.dispose())
    await session.start()
    const { env } = Object((await session.customRequest('fake/env')).body)
    expect(env.ORCA_DEBUGGEE_ONLY).toBeUndefined()
  })

  it('restarts with a fresh start from the same spec when restart is unsupported', async () => {
    const { session } = makeSession({ adapter: 'debugpy' })
    await session.start()
    await waitFor(session, (s) => s.status === 'stopped')
    await session.restart()
    expect(await waitFor(session, (s) => s.status === 'stopped')).toMatchObject({
      stoppedReason: 'breakpoint'
    })
    expect(commands(await received(session), 0)[0]).toBe('initialize')
  })
})

describe('SessionBreakpoints', () => {
  const entry = { id: 'a', line: 4, enabled: true, condition: 'x > 1' }

  it('reports a condition the adapter cannot honour as unsupported, and does not send it', () => {
    const bps = new SessionBreakpoints(false)
    const { args, sent } = bps.prepare('/f.py', [entry, { id: 'b', line: 9, enabled: true }], {})
    expect(args.breakpoints).toEqual([{ line: 9 }])
    expect(sent).toEqual(['b'])
    expect(bps.status('/f.py')[0]).toMatchObject({
      state: 'unsupported',
      message: 'conditions unsupported by this debugger'
    })
  })

  it('keeps bound state when a re-send is answered with an empty array, and follows breakpoint events', () => {
    const bps = new SessionBreakpoints(true)
    const caps = { supportsConditionalBreakpoints: true }
    const first = bps.prepare('/f.js', [entry], caps)
    bps.applyAnswer('/f.js', first.sent, [{ id: 7, verified: true, line: 5 }])
    const again = bps.prepare('/f.js', [entry], caps)
    bps.applyAnswer('/f.js', again.sent, [])
    expect(bps.status('/f.js')[0]).toMatchObject({ state: 'verified', line: 5 })
    bps.applyEvent({ reason: 'changed', breakpoint: { id: 7, verified: false, message: 'gone' } })
    expect(bps.status('/f.js')[0]).toMatchObject({ state: 'failed', message: 'gone' })
    expect(bps.status('/f.js')[0].line).toBeUndefined()
  })

  it('never lets a non-empty re-send answer downgrade a bound breakpoint', () => {
    const bps = new SessionBreakpoints(true)
    const caps = { supportsConditionalBreakpoints: true }
    const first = bps.prepare('/f.js', [entry], caps)
    bps.applyAnswer('/f.js', first.sent, [{ id: 7, verified: true, line: 5 }])
    const fresh = { id: 'n', line: 9, enabled: true }
    const again = bps.prepare('/f.js', [entry, fresh], caps)
    const weaker = [
      { id: 7, verified: false, message: 'breakpoint.provisionalBreakpoint' },
      { id: 8, verified: false, message: 'no code here' }
    ]
    bps.applyAnswer('/f.js', again.sent, weaker, true)
    expect(bps.status('/f.js')).toEqual([
      expect.objectContaining({ id: 'a', state: 'verified', line: 5 }),
      // A breakpoint new in this re-send has no established answer to keep.
      expect.objectContaining({ id: 'n', state: 'failed', message: 'no code here' })
    ])
  })
})
