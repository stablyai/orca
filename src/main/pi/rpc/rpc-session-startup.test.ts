import { waitForPiSpawn } from './rpc-startup-open'
import { JsonlRpcAgentConnection } from '../../jsonl-rpc/agent-connection'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { JsonlRpcPeer } from '../../jsonl-rpc/peer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  type FakeConnection,
  restart,
  sessionId,
  setup
} from './rpc-session-adapter.test-fixture'

function openAt8(h: Awaited<ReturnType<typeof setup>>, acquisitionGeneration: string) {
  return h.adapter.open({
    sessionId,
    fence: 8,
    acquisitionGeneration,
    signal: new AbortController().signal
  })
}

const recordedState = readFileSync(
  new URL('./__fixtures__/command-only.jsonl', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(JSON.parse(line).raw))
  .find((frame) => frame.type === 'response' && frame.command === 'get_state')

function stateThroughPeer(connection: FakeConnection) {
  const input = new PassThrough()
  const output = new PassThrough()
  const peer = new JsonlRpcPeer(input, output)
  let requestId: string
  output.on('data', (chunk) => {
    requestId = JSON.parse(String(chunk)).id
  })
  const request = connection.request.bind(connection)
  connection.request = (command, params, options?: Parameters<JsonlRpcPeer['request']>[2]) =>
    command === 'get_state' ? peer.request(command, params, options) : request(command, params)
  connection.abortRequest = () => peer.close()
  return () => input.write(`${JSON.stringify({ ...recordedState, id: requestId })}\n`)
}

afterEach(async () => {
  await closePiRpcAdapterFixtures()
  vi.useRealTimers()
})

describe('Pi host awaited open', () => {
  it('opens on Pi state received after the transport default would expire', async () => {
    const h = await setup()
    vi.useFakeTimers()
    let reply!: () => unknown
    const { acquired, child } = await restart(h, (connection) => {
      reply = stateThroughPeer(connection)
    })
    const opened = expect(openAt8(h, acquired.acquisitionGeneration)).resolves.toMatchObject({
      reportedOptions: { model: 'openai-codex/gpt-6.1-sol', effort: 'medium' }
    })
    await vi.advanceTimersByTimeAsync(31_000)
    reply()
    await opened
    await h.adapter.dispatch({
      sessionId,
      fence: 8,
      clientMessageId: 'slow-start',
      executionOptions: {},
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    })
    expect(child.sent).toMatchObject([{ type: 'prompt', message: 'hello' }])
  })

  it('fails an open if its lane fails while the state request is pending', async () => {
    let refuse = false
    const h = await setup({}, (sink) => ({
      ...sink,
      tryAppendTransition: (transition) =>
        refuse ? { accepted: false, reason: 'failed' } : sink.tryAppendTransition!(transition)
    }))
    let reply!: () => unknown
    const { acquired, child } = await restart(h, (connection) => {
      reply = stateThroughPeer(connection)
    })
    const opening = openAt8(h, acquired.acquisitionGeneration)
    refuse = true
    child.receive({
      type: 'extension_ui_request',
      id: 'startup-confirm',
      method: 'confirm',
      title: 'Continue?',
      message: 'Ready?'
    })
    await expect(opening).rejects.toMatchObject({ message: 'failed', retry: 'never' })
    refuse = false
    reply()
    await expect(openAt8(h, acquired.acquisitionGeneration)).rejects.toThrow('failed')
    await expect(
      h.adapter.dispatch({
        sessionId,
        fence: 8,
        clientMessageId: 'failed-start',
        executionOptions: {},
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      })
    ).rejects.toThrow('Pi session is not live')
    expect(child.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt' }))
  })
})

it('acquires a hosted Pi only after its real PID arrives', async () => {
  const h = await setup()
  const spawned = Promise.withResolvers<void>()
  let child: FakeConnection | undefined
  h.onSpawned.mockClear()
  const restarting = restart(h, (connection) => {
    child = connection
    Object.defineProperty(connection, 'pid', { configurable: true, value: undefined })
    Object.defineProperty(connection, 'spawned', { value: spawned.promise })
  })
  await vi.waitFor(() => expect(child).toBeDefined())
  expect(h.onSpawned).not.toHaveBeenCalled()
  Object.defineProperty(child, 'pid', { value: 5678 })
  spawned.resolve()
  await expect(restarting).resolves.toMatchObject({ acquired: { process: { pid: 5678 } } })
  expect(h.onSpawned).toHaveBeenCalledWith(expect.objectContaining({ pid: 5678 }))
})

it('owns rejection of the real startup getter without discarding another promise', async () => {
  const ready = Promise.withResolvers<void>()
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    ready: ready.promise,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => false)
  })
  const connection = new JsonlRpcAgentConnection({ command: '/fake/pi', args: [] }, {}, () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Pending child fixture supplies streams, readiness and held lifecycle consumed by the production connection.
    return child as never
  })
  const waiting = waitForPiSpawn(connection, new AbortController().signal)
  const rejected = expect(waiting).rejects.toThrow('host refused startup')
  ready.reject(new Error('host refused startup'))
  await rejected
  child.emit('error', Object.assign(new Error('not started'), { code: 'ENOENT' }))
  child.stdout.end()
  child.stderr.end()
  child.emit('close', null, null)
  await connection.close()
})
