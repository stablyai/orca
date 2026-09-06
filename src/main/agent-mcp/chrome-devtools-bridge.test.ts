import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import { callChromeDevtoolsTool, listChromeDevtoolsTools } from './chrome-devtools-bridge'
import { ChromeDevtoolsTransport } from './chrome-devtools-transport'
import {
  runChromeDevtoolsSession,
  type ChromeDevtoolsSessionResponse
} from './chrome-devtools-session'

vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: vi.fn() }))
vi.mock('../../shared/child-process/process-tree-termination', () => ({
  forceTerminateProcessTree: vi.fn().mockResolvedValue(true)
}))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: () => 'resolved-npx'
}))

type Request = { id?: number; method: string; params?: Record<string, unknown> }
function fakeServer(reply?: (request: Request) => unknown, handshakeDelayMs = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    pid: 12345
  })
  const requests: Request[] = []
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as Request
    requests.push(request)
    if (request.id === undefined) {
      return
    }
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' }
          }
        : reply?.(request)
    if (result !== undefined) {
      const send = (): void => {
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
      }
      if (request.method === 'initialize' && handshakeDelayMs) {
        setTimeout(send, handshakeDelayMs)
      } else {
        queueMicrotask(send)
      }
    }
  })
  child.stdin.once('finish', () => {
    child.exitCode = 0
    child.emit('close', 0)
  })
  vi.mocked(spawnProcess).mockReturnValue(child as unknown as ReturnType<typeof spawnProcess>)
  return { child, requests }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('Chrome DevTools stdio bridge', () => {
  it('discovers paginated tools with complete schemas through the safe process boundary', async () => {
    const schema = { type: 'object', properties: { expression: { type: 'string' } } }
    const { child } = fakeServer((request) =>
      request.params?.cursor
        ? { tools: [{ name: 'evaluate_script', inputSchema: schema }] }
        : { tools: [{ name: 'list_pages', inputSchema: { type: 'object' } }], nextCursor: 'more' }
    )
    const result = await listChromeDevtoolsTools()
    expect(result.tools).toHaveLength(2)
    expect(result.tools[1].inputSchema).toEqual(schema)
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'resolved-npx',
        args: expect.arrayContaining([
          '--autoConnect',
          '--no-usage-statistics',
          '--no-performance-crux'
        ])
      })
    )
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('preserves tool error results and image/resource content without string flattening', async () => {
    const result = {
      isError: true,
      content: [
        { type: 'text', text: 'Tool failed' },
        { type: 'image', mimeType: 'image/png', data: 'AA==' },
        { type: 'resource', resource: { uri: 'test://snapshot', text: 'payload' } }
      ]
    }
    const { requests } = fakeServer(() => result)
    expect(await callChromeDevtoolsTool('example', { query: 'quote " and $()' })).toEqual(result)
    expect(requests.find((item) => item.method === 'tools/call')?.params).toEqual({
      name: 'example',
      arguments: { query: 'quote " and $()' }
    })
  })

  it('bounds a non-responsive request and closes the process', async () => {
    const { child } = fakeServer()
    await expect(callChromeDevtoolsTool('never', {}, { timeoutMs: 10 })).rejects.toThrow(
      /timed out/i
    )
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('rejects repeated pagination cursors and closes', async () => {
    const { child } = fakeServer(() => ({ tools: [], nextCursor: 'same' }))
    await expect(listChromeDevtoolsTools()).rejects.toThrow('repeated')
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('preserves page and snapshot state across sequential session calls', async () => {
    let snapshotTaken = false
    fakeServer((request) => {
      if (request.method === 'tools/list') {
        return { tools: [{ name: 'take_snapshot', inputSchema: { type: 'object' } }] }
      }
      if (request.params?.name === 'take_snapshot') {
        snapshotTaken = true
        return { content: [{ type: 'text', text: 'uid=1_2 button' }] }
      }
      return {
        isError: !snapshotTaken,
        content: [{ type: 'text', text: snapshotTaken ? 'Clicked 1_2' : 'No snapshot' }]
      }
    })
    const responses: ChromeDevtoolsSessionResponse[] = []
    async function* lines() {
      yield JSON.stringify({ id: 'snapshot', type: 'call', tool: 'take_snapshot' })
      expect(responses[0].ok).toBe(true)
      yield JSON.stringify({ id: 'click', type: 'call', tool: 'click', arguments: { uid: '1_2' } })
      yield JSON.stringify({ id: 'tools', type: 'tools' })
    }
    await runChromeDevtoolsSession(lines(), (response) => responses.push(response))
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(responses.map((response) => [response.id, response.ok])).toEqual([
      ['snapshot', true],
      ['click', true],
      ['tools', true]
    ])
    expect(responses[1].result).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'Clicked 1_2' }]
    })
  })

  it('reports invalid session input without running a tool and continues with correlation IDs', async () => {
    const { requests } = fakeServer(() => ({ content: [{ type: 'text', text: 'ok' }] }))
    async function* lines() {
      yield 'invalid json'
      yield JSON.stringify({ id: 2, type: 'call', tool: 'click', arguments: [] })
      yield JSON.stringify({ id: 3, type: 'call', tool: 'list_pages' })
    }
    const responses: ChromeDevtoolsSessionResponse[] = []
    await runChromeDevtoolsSession(lines(), (response) => responses.push(response))
    expect(responses.map((response) => [response.id, response.ok])).toEqual([
      [null, false],
      [2, false],
      [3, true]
    ])
    expect(requests.filter((request) => request.method === 'tools/call')).toHaveLength(1)
  })

  it('buffers piped requests and EOF while the MCP handshake is starting', async () => {
    const { requests } = fakeServer(() => ({ content: [{ type: 'text', text: 'ok' }] }), 20)
    const input = new PassThrough()
    const lines = createInterface({ input, terminal: false })
    const responses: ChromeDevtoolsSessionResponse[] = []
    const session = runChromeDevtoolsSession(lines, (response) => responses.push(response))
    input.end(`${JSON.stringify({ id: 1, type: 'call', tool: 'list_pages' })}\n`)
    await session
    expect(responses).toHaveLength(1)
    expect(responses[0].id).toBe(1)
    expect(requests.filter((request) => request.method === 'tools/call')).toHaveLength(1)
  })

  it('stops the session after a request timeout before queued actions can run', async () => {
    const { requests, child } = fakeServer()
    async function* lines() {
      yield JSON.stringify({ id: 1, type: 'call', tool: 'never' })
      yield JSON.stringify({ id: 2, type: 'call', tool: 'click' })
    }
    const responses: ChromeDevtoolsSessionResponse[] = []
    await runChromeDevtoolsSession(lines(), (response) => responses.push(response), {
      timeoutMs: 10
    })
    expect(responses).toHaveLength(1)
    expect(responses[0].ok).toBe(false)
    expect(requests.filter((request) => request.method === 'tools/call')).toHaveLength(1)
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('rejects malformed MCP output and closes instead of waiting for the request timeout', async () => {
    const { child } = fakeServer()
    const pending = callChromeDevtoolsTool('never', {}, { timeoutMs: 1000 })
    setTimeout(() => child.stdout.write('invalid\n'), 5)
    await expect(pending).rejects.toThrow(/closed/i)
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('handles stream failures without uncaught events', async () => {
    const { child } = fakeServer()
    const pending = callChromeDevtoolsTool('never', {}, { timeoutMs: 1000 })
    setTimeout(() => child.stdin.emit('error', new Error('EPIPE')), 5)
    await expect(pending).rejects.toThrow(/closed/i)
  })

  it('terminates an owned process tree when stdin closure cannot stop it', async () => {
    vi.useFakeTimers()
    const { child } = fakeServer()
    child.stdin.removeAllListeners('finish')
    const transport = new ChromeDevtoolsTransport({ program: 'fixture' })
    await transport.start()
    const closing = transport.close()
    await vi.advanceTimersByTimeAsync(2000)
    await closing
    expect(forceTerminateProcessTree).toHaveBeenCalledWith(child)
  })
})
