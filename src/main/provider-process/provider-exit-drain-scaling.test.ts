import type { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { createAcpAgentConnection } from '../acp/acp-agent-connection'
import { AcpScriptedAgent, type FakeFrame } from '../acp/acp-scripted-agent.test-support'
import { openCodexAppServerConnection } from '../codex/app-server/codex-app-server-connection'
import { JsonlRpcAgentConnection } from '../jsonl-rpc/agent-connection'
import { PROVIDER_EXIT_OUTPUT_DRAIN_MS } from './provider-exit-output-drain'
import type * as OutputDrain from './provider-exit-output-drain'
import type { terminateProviderProcessTree } from './provider-process-teardown'

// Every output drain any transport starts, the listeners it attached, and whether it finished.
type Attached = { emitter: EventEmitter; listener: ReturnType<EventEmitter['listeners']>[number] }
const drains = vi.hoisted(() => new Array<{ attached: Attached[]; finished: number }>())
vi.mock('./provider-exit-output-drain', async (original) => {
  const actual = await original<typeof OutputDrain>()
  const watched = (stdout: EventEmitter, child?: EventEmitter): Attached[] =>
    [
      { emitter: stdout, event: 'end' },
      { emitter: stdout, event: 'close' },
      ...(child ? [{ emitter: child, event: 'close' }] : [])
    ].flatMap(({ emitter, event }) =>
      emitter.listeners(event).map((listener) => ({ emitter, listener }))
    )
  return {
    ...actual,
    afterProviderOutputDrains: (
      ...[stdout, finish, child]: Parameters<typeof OutputDrain.afterProviderOutputDrains>
    ) => {
      const before = new Set(watched(stdout, child).map(({ listener }) => listener))
      const drain: { attached: Attached[]; finished: number } = { attached: [], finished: 0 }
      drains.push(drain)
      const done = actual.afterProviderOutputDrains(
        stdout,
        () => {
          drain.finished += 1
          finish()
        },
        child
      )
      drain.attached = watched(stdout, child).filter(({ listener }) => !before.has(listener))
      return done
    }
  }
})
vi.mock('./provider-process-teardown', () => ({
  terminateProviderProcessTree: vi.fn<typeof terminateProviderProcessTree>(
    async () => 'unverifiable'
  )
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Child = ReturnType<typeof fakeChild>
/** One connection over a fake child, with a call the agent has not answered yet. */
type Opened = {
  child: Child
  pending: Promise<unknown>
  /** The agent's own answer to that call, written to its stdout. */
  answer: () => void
  close: () => Promise<unknown>
  lostBeforeExit?: () => Error | undefined
}

function fakeChild(stdout = new PassThrough(), stdin = new PassThrough()) {
  return Object.assign(createFakePipedChild(), {
    // Outside any real process table so teardown never mistakes an unrelated process for it.
    pid: 9_999_999,
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => true
  })
}

const TRANSPORTS: Record<string, () => Promise<Opened>> = {
  acp: async () => {
    const agent = new AcpScriptedAgent()
    const child = fakeChild(agent.stdout, agent.stdin)
    let prompt: FakeFrame | undefined
    agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
    agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
    agent.on('session/prompt', (frame) => {
      prompt = frame
    })
    const spawn: PipedProcessSpawner = () => child
    const connection = createAcpAgentConnection(
      { command: 'fixture-acp-agent', args: ['--acp'], cwd: '/execution-host/folder', env: {} },
      {},
      spawn
    )
    await connection.start({ cwd: '/execution-host/folder', mcpServers: [] })
    const pending = connection.prompt([{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(prompt).toBeDefined())
    return {
      child,
      pending,
      answer: () => agent.reply(prompt!, { stopReason: 'end_turn' }),
      close: () => connection.close(),
      lostBeforeExit: () => connection.lostBeforeExit
    }
  },
  jsonl: async () => {
    const child = fakeChild()
    const spawn: PipedProcessSpawner = () => child
    const connection = new JsonlRpcAgentConnection(
      { command: 'fixture-rpc-agent', args: ['--mode', 'rpc'], cwd: '/folder', env: {} },
      {},
      spawn
    )
    return {
      child,
      pending: connection.request('get_state'),
      answer: () =>
        child.stdout.write(
          '{"type":"response","command":"get_state","id":"orca-1","success":true,"data":{}}\n'
        ),
      close: () => connection.close()
    }
  },
  codex: async () => {
    const child = fakeChild()
    child.stdin.once('data', () => child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only events, pid, streams and kill from this stub.
    const spawnImpl = (() => child) as unknown as typeof spawnProcess
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    )
    return {
      child,
      pending: connection.request('thread/start', {}),
      answer: () => child.stdout.write(`${JSON.stringify({ id: 2, result: {} })}\n`),
      close: () => connection.close()
    }
  }
}

/** Listeners an output drain attached that are still attached. */
const drainListeners = () =>
  drains.reduce(
    (sum, drain) =>
      sum +
      drain.attached.filter(({ emitter, listener }) =>
        [...emitter.listeners('end'), ...emitter.listeners('close')].includes(listener)
      ).length,
    0
  )

/** Runs `count` connections through each terminal order and counts what each one leaves. */
async function drainCycles(open: () => Promise<Opened>, count: number) {
  drains.length = 0
  const timers = vi.spyOn(globalThis, 'setTimeout')
  const settled = { answered: 0, failed: 0 }
  const left: { timers: number; drainListeners: number }[] = []
  for (let cycle = 0; cycle < count; cycle++) {
    for (const answered of [true, false]) {
      const opened = await open()
      const { child } = opened
      opened.pending.then(
        () => (settled.answered += 1),
        () => (settled.failed += 1)
      )
      if (answered) {
        // The exit is seen before the answer written just before it; the drain waits for it.
        child.emit('exit', 0, null)
        child.emit('exit', 0, null)
        opened.answer()
        child.stdout.end()
      } else {
        // The agent stops reading, twice over, and exits with its stdout still held open.
        const lost = new Error('broken pipe')
        child.stdin.emit('error', lost)
        child.stdin.emit('error', new Error('a later failure'))
        child.stdin.emit('close')
        child.emit('exit', 1, null)
        child.emit('exit', 1, null)
        await vi.advanceTimersByTimeAsync(PROVIDER_EXIT_OUTPUT_DRAIN_MS)
        // ACP keeps why the agent stopped reading, its first reason only, for its exit's readers.
        expect(opened.lostBeforeExit?.() ?? lost).toBe(lost)
      }
      await vi.advanceTimersByTimeAsync(0)
      // Read before the child's own close, which would fire any listener a drain left behind.
      const listening = drainListeners()
      await opened.close()
      child.emit('close', 0, null)
      await vi.advanceTimersByTimeAsync(PROVIDER_EXIT_OUTPUT_DRAIN_MS)
      left.push({ timers: vi.getTimerCount(), drainListeners: listening })
    }
  }
  const timersScheduled = timers.mock.calls.length
  timers.mockRestore()
  const finished = drains.map((drain) => drain.finished)
  return { settled, left, timersScheduled, drains: drains.length, finished }
}

it.each(Object.keys(TRANSPORTS))(
  '%s: settles each pending call once and leaves no drain timer or listener, at N and 10N',
  async (transport) => {
    vi.useFakeTimers()
    const n = await drainCycles(TRANSPORTS[transport], 10)
    const tenN = await drainCycles(TRANSPORTS[transport], 100)
    for (const run of [n, tenN]) {
      for (const held of run.left) {
        expect(held).toEqual({ timers: 0, drainListeners: 0 })
      }
    }
    // An answer written before exit wins; an unanswered call fails once, at the drain bound.
    expect(n.settled).toEqual({ answered: 10, failed: 10 })
    expect(tenN.settled).toEqual({ answered: 100, failed: 100 })
    expect(tenN.timersScheduled).toBe(10 * n.timersScheduled)
    // Each drain finishes exactly once, and a connection starts a fixed number of them.
    for (const run of [n, tenN]) {
      expect(run.finished.every((finished) => finished === 1)).toBe(true)
    }
    expect(n.drains).toBeGreaterThan(0)
    expect(tenN.drains).toBe(10 * n.drains)
  }
)

/** JSON-lines output ending while its root still runs, then the exit after it, no exit at all, or
 *  Orca closing while an exit's drain is pending; counts what each cycle leaves at its close. */
async function jsonlLiveRootCycles(count: number) {
  drains.length = 0
  const timers = vi.spyOn(globalThis, 'setTimeout')
  const settled = { answered: 0, failed: 0 }
  const left: { timers: number; drainListeners: number }[] = []
  const waitsAfterExit: number[] = []
  for (let cycle = 0; cycle < count; cycle++) {
    for (const ending of ['exit after EOF', 'no exit', 'close mid-drain'] as const) {
      const opened = await TRANSPORTS.jsonl()
      const { child } = opened
      opened.pending.then(
        () => (settled.answered += 1),
        () => (settled.failed += 1)
      )
      if (ending === 'close mid-drain') {
        child.emit('exit', 1, null)
      } else {
        child.stdout.end()
        await vi.advanceTimersByTimeAsync(0)
        if (ending === 'exit after EOF') {
          await vi.advanceTimersByTimeAsync(PROVIDER_EXIT_OUTPUT_DRAIN_MS / 2)
          child.emit('exit', 1, null)
          await vi.advanceTimersByTimeAsync(0)
          // The exit settles the call and ends the wait its output's end started.
          waitsAfterExit.push(vi.getTimerCount())
        } else {
          await vi.advanceTimersByTimeAsync(PROVIDER_EXIT_OUTPUT_DRAIN_MS)
        }
      }
      await vi.advanceTimersByTimeAsync(0)
      const closing = opened.close()
      if (ending === 'no exit') {
        child.emit('exit', 0, null)
      }
      await closing
      await vi.advanceTimersByTimeAsync(0)
      left.push({ timers: vi.getTimerCount(), drainListeners: drainListeners() })
      child.emit('close', 0, null)
      await vi.advanceTimersByTimeAsync(PROVIDER_EXIT_OUTPUT_DRAIN_MS)
    }
  }
  const timersScheduled = timers.mock.calls.length
  timers.mockRestore()
  const finished = drains.map((drain) => drain.finished)
  return { settled, left, waitsAfterExit, timersScheduled, drains: drains.length, finished }
}

it('jsonl: output ending before a live root exits leaves no timer or listener, at N and 10N', async () => {
  vi.useFakeTimers()
  const n = await jsonlLiveRootCycles(10)
  const tenN = await jsonlLiveRootCycles(100)
  for (const run of [n, tenN]) {
    for (const held of run.left) {
      expect(held).toEqual({ timers: 0, drainListeners: 0 })
    }
    expect(run.waitsAfterExit.every((waits) => waits === 0)).toBe(true)
    expect(run.finished.every((finished) => finished === 1)).toBe(true)
  }
  // Every unanswered call fails exactly once, however its output and process ended.
  expect(n.settled).toEqual({ answered: 0, failed: 30 })
  expect(tenN.settled).toEqual({ answered: 0, failed: 300 })
  expect(tenN.timersScheduled).toBe(10 * n.timersScheduled)
  expect(tenN.drains).toBe(10 * n.drains)
})
