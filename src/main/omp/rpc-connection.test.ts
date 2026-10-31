import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JsonlRpcRequestOptions } from '../jsonl-rpc/peer-oversized-record'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type { JsonlRpcAgentConnectionOptions } from '../jsonl-rpc/agent-connection'
import { openOmpRpcConnection } from './rpc-connection'

const transport = vi.hoisted(() => ({
  request:
    vi.fn<
      (
        command: string,
        params?: Record<string, unknown>,
        options?: JsonlRpcRequestOptions
      ) => Promise<unknown>
    >(),
  send: vi.fn(),
  autoReady: true,
  receive: (_frame: { type: string; [key: string]: unknown }) => {}
}))

vi.mock('../jsonl-rpc/agent-connection', () => ({
  JsonlRpcAgentConnection: class {
    request = transport.request
    send = transport.send
    constructor(_launch: unknown, options: JsonlRpcAgentConnectionOptions) {
      transport.receive = (frame) => options.onRecord?.(frame)
      if (transport.autoReady) {
        queueMicrotask(() =>
          transport.receive({ type: 'ready', supportedProtocolVersions: [1, 2] })
        )
      }
    }
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  transport.autoReady = true
})
afterEach(() => vi.useRealTimers())

it('opens older RPC UI sessions without opting into grouped Ask', async () => {
  transport.request.mockImplementation(async (command) => {
    if (command === 'negotiate_protocol') {
      return { protocolVersion: 2 }
    }
    if (command === 'set_ask_dialog') {
      throw new JsonlRpcResponseError(command, 'Unknown command: set_ask_dialog')
    }
    if (command === 'get_available_commands') {
      return { commands: [] }
    }
    return { isSettled: true, queuedMessageCount: 0, sessionFile: '/session.jsonl' }
  })
  const connection = openOmpRpcConnection({ command: 'omp', args: [] }, {})
  await expect(connection.request('get_state')).resolves.toMatchObject({ pendingMessageCount: 0 })
  await connection.send({ type: 'prompt', id: 'old', message: 'Hello' })
  expect(transport.send).toHaveBeenCalledWith({ type: 'prompt', id: 'old', message: 'Hello' })
})

it('does not hide failures while enabling grouped Ask', async () => {
  transport.request.mockImplementation(async (command) => {
    if (command === 'negotiate_protocol') {
      return { protocolVersion: 2 }
    }
    throw new JsonlRpcResponseError(command, 'Extension initialization failed')
  })
  const connection = openOmpRpcConnection({ command: 'omp', args: [] }, {})
  await expect(connection.request('get_state')).rejects.toThrow('Extension initialization failed')
  expect(transport.send).not.toHaveBeenCalled()
})

it('loads relocation policy before the first prompt and applies dynamic command aliases', async () => {
  const catalog = Promise.withResolvers<unknown>()
  transport.request.mockImplementation(async (command) => {
    if (command === 'negotiate_protocol') {
      return { protocolVersion: 2 }
    }
    if (command === 'get_available_commands') {
      return catalog.promise
    }
    return {}
  })
  const received = vi.fn()
  const connection = openOmpRpcConnection({ command: 'omp', args: [] }, { onRecord: received })
  let sent = false
  const first = connection
    .send({ type: 'prompt', id: 'first', message: '/move elsewhere' })
    .then(() => {
      sent = true
    })
  await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith('get_available_commands'))
  expect(sent).toBe(false)
  expect(transport.send).not.toHaveBeenCalled()
  catalog.resolve({ commands: [{ name: 'move', source: 'builtin' }] })
  await first
  expect(transport.send).not.toHaveBeenCalled()
  expect(received).toHaveBeenCalledWith(
    expect.objectContaining({ promptId: 'first', success: false })
  )
  transport.receive({
    type: 'available_commands_update',
    commands: [
      { name: 'wt', source: 'builtin', aliases: ['worktree'] },
      { name: 'custom', source: 'extension' }
    ]
  })
  await connection.send({ type: 'prompt', id: 'alias', message: '/worktree:elsewhere' })
  expect(transport.send).not.toHaveBeenCalled()
  await connection.send({ type: 'prompt', id: 'extension', message: '/custom' })
  expect(transport.send).toHaveBeenCalledOnce()
})

it('bounds each caller across readiness and shared initialization without cancelling other callers', async () => {
  vi.useFakeTimers()
  transport.autoReady = false
  const negotiation = Promise.withResolvers<unknown>()
  transport.request.mockImplementation(async (command) => {
    if (command === 'negotiate_protocol') {
      return negotiation.promise
    }
    if (command === 'get_available_commands') {
      return { commands: [] }
    }
    return {}
  })
  const connection = openOmpRpcConnection({ command: 'omp', args: [] }, {})
  const short = connection.request('short', {}, { timeoutMs: 50 })
  const shortOutcome = expect(short).rejects.toThrow('Agent did not answer short in time')
  const long = connection.request('long', {}, { timeoutMs: 200 })
  const unbounded = connection.request('unbounded', {}, { timeoutMs: null })
  await vi.advanceTimersByTimeAsync(30)
  transport.receive({ type: 'ready', supportedProtocolVersions: [2] })
  await vi.advanceTimersByTimeAsync(30)
  await shortOutcome
  expect(transport.request).not.toHaveBeenCalledWith('short', expect.anything(), expect.anything())
  negotiation.resolve({ protocolVersion: 2 })
  await expect(long).resolves.toEqual({})
  await expect(unbounded).resolves.toEqual({})
  expect(transport.request).toHaveBeenCalledWith('long', {}, { timeoutMs: 140 })
  expect(transport.request).toHaveBeenCalledWith('unbounded', {}, { timeoutMs: null })
  expect(
    transport.request.mock.calls.filter(([command]) => command === 'negotiate_protocol')
  ).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('gives later callers their own deadlines while initialization remains pending', async () => {
  vi.useFakeTimers()
  transport.autoReady = false
  transport.request.mockImplementation(async (command) =>
    command === 'negotiate_protocol'
      ? { protocolVersion: 2 }
      : command === 'get_available_commands'
        ? { commands: [] }
        : {}
  )
  const connection = openOmpRpcConnection({ command: 'omp', args: [] }, {})
  const first = connection.request('first', {}, { timeoutMs: 200 })
  await vi.advanceTimersByTimeAsync(10)
  const second = expect(connection.request('second', {}, { timeoutMs: 20 })).rejects.toThrow(
    'Agent did not answer second in time'
  )
  await vi.advanceTimersByTimeAsync(20)
  await second
  transport.receive({ type: 'ready', supportedProtocolVersions: [2] })
  await expect(first).resolves.toEqual({})
  expect(transport.request).toHaveBeenCalledWith('first', {}, { timeoutMs: 170 })
  expect(vi.getTimerCount()).toBe(0)
})
