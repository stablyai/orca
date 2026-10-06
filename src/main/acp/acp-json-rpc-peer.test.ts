import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpJsonRpcPeer, type AcpPeerHandlers, type AcpPeerOptions } from './acp-json-rpc-peer'
import {
  AcpConnectionClosedError,
  AcpFrameTooLargeError,
  AcpRequestTimeoutError,
  AcpRpcError
} from './acp-errors'
import { AcpScriptedAgent, deferred, tick } from './acp-scripted-agent.test-support'

const peers: AcpJsonRpcPeer[] = []
const agents: AcpScriptedAgent[] = []
function fixture(handlers: AcpPeerHandlers = {}, options: AcpPeerOptions = {}) {
  const agent = new AcpScriptedAgent()
  const peer = new AcpJsonRpcPeer(agent.stdout, agent.stdin, handlers, options)
  agents.push(agent)
  peers.push(peer)
  return { peer, agent }
}
afterEach(() => {
  peers.splice(0).forEach((peer) => peer.close())
  agents.splice(0).forEach((agent) => agent.close())
  vi.useRealTimers()
})

describe('ACP JSON-RPC peer', () => {
  it('routes interleaved requests in both directions without conflating id types', async () => {
    const { peer, agent } = fixture({ onRequest: (method, params) => ({ method, params }) })
    const first = peer.request('first', {})
    const second = peer.request('second', {})
    await tick()
    expect(agent.frames.map((frame) => frame.id)).toEqual([1, 2])
    agent.send({ jsonrpc: '2.0', id: '1', result: 'not the numeric id' })
    const fromAgent = agent.request(1, '_question', { text: 'hello' })
    agent.reply(agent.frames[1], 'second result')
    agent.reply(agent.frames[0], 'first result')
    expect(await second).toBe('second result')
    expect(await first).toBe('first result')
    expect(await fromAgent).toMatchObject({
      id: 1,
      result: { method: '_question', params: { text: 'hello' } }
    })
    expect(await agent.request(null, '_null_id', {})).toMatchObject({
      id: null,
      result: { method: '_null_id' }
    })
  })

  it('returns method-not-found and preserves explicit handler error objects', async () => {
    const { agent } = fixture({
      onRequest: (method) => {
        if (method === '_denied') {
          throw new AcpRpcError(-32005, 'Denied', { reason: 'policy' })
        }
        if (method === '_crash') {
          throw new Error('Handler failed')
        }
        throw new AcpRpcError(-32601, 'Unknown method')
      }
    })
    expect(await agent.request('missing', '_missing', {})).toMatchObject({
      error: { code: -32601 }
    })
    expect(await agent.request('denied', '_denied', {})).toMatchObject({
      error: { code: -32005, message: 'Denied', data: { reason: 'policy' } }
    })
    expect(await agent.request('crash', '_crash', {})).toMatchObject({
      error: { code: -32603, message: 'Handler failed' }
    })
  })

  it('allows the agent to reuse a request id after receiving its response', async () => {
    const { agent } = fixture({ onRequest: () => ({ answer: true }) })
    expect(await agent.request('reused', '_question', {})).toMatchObject({
      result: { answer: true }
    })
    expect(await agent.request('reused', '_question', {})).toMatchObject({
      result: { answer: true }
    })
  })

  it('ignores malformed and oversized lines then resumes at the next newline', async () => {
    const diagnostics: string[] = []
    const notified: unknown[] = []
    const { peer, agent } = fixture(
      {
        onDiagnostic: (message) => diagnostics.push(message),
        onNotification: (_method, params) => notified.push(params)
      },
      { maxLineBytes: 100 }
    )
    agent.stdout.write('not json\n[]\n{"jsonrpc":"1.0","method":"bad"}\n')
    for (let i = 0; i < 20; i++) {
      agent.stdout.write('x'.repeat(40))
    }
    agent.stdout.write('\n')
    const data = Buffer.from('{"jsonrpc":"2.0","method":"notice","params":"✓"}\r\n')
    const split = data.indexOf(Buffer.from('✓')) + 1
    agent.stdout.write(data.subarray(0, split))
    agent.stdout.write(data.subarray(split))
    agent.on('valid', (frame) => agent.reply(frame, 'ok'))
    expect(await peer.request('valid', {})).toBe('ok')
    expect(notified).toEqual(['✓'])
    expect(diagnostics).toContain('Ignored ACP line: invalid-json')
    expect(diagnostics).toContain('Ignored ACP line: line-too-long (unknown)')
    expect(diagnostics).toContain('Ignored invalid ACP JSON-RPC envelope')
  })

  it('settles whoever was owed a message that exceeded the line limit', async () => {
    const diagnostics: string[] = []
    const { peer, agent } = fixture(
      { onDiagnostic: (message) => diagnostics.push(message), onRequest: () => 'unused' },
      { maxLineBytes: 200 }
    )
    const filler = 'x'.repeat(300)
    const big = peer.request('session/load', {})
    agent.stdout.write(`{"jsonrpc":"2.0","id":1,"result":{"history":"${filler}"}}\n`)
    const lost = await big.catch((error: unknown) => error)
    expect(lost).toBeInstanceOf(AcpFrameTooLargeError)
    expect(lost).toMatchObject({ method: 'session/load', maxBytes: 200 })
    const answer = new Promise<unknown>((resolve) => {
      agent.stdin.on('data', (chunk: string) => resolve(JSON.parse(chunk)))
    })
    agent.stdout.write(
      `{"jsonrpc":"2.0","id":"q","method":"session/request_permission","params":{"diff":"${filler}"}}\n`
    )
    expect(await answer).toMatchObject({ id: 'q', error: { code: -32600 } })
    agent.stdout.write(`{"jsonrpc":"2.0","method":"session/update","params":{"x":"${filler}"}}\n`)
    agent.stdout.write(`${filler}\n`)
    await tick()
    expect(peer.closed).toBe(false)
    expect(diagnostics).toEqual([
      'Ignored ACP line: line-too-long (response)',
      'Ignored ACP line: line-too-long (server-request)',
      'Ignored ACP line: line-too-long (notification)',
      'Ignored ACP line: line-too-long (unknown)'
    ])
    const stranded = peer.request('session/prompt', {})
    agent.stdout.write(`{"jsonrpc":"2.0","id":2,"vendor":"${filler}"}\n`)
    await expect(stranded).rejects.toBeInstanceOf(AcpFrameTooLargeError)
    expect(peer.closed).toBe(true)
  })

  it('rejects malformed matching responses instead of leaving calls pending', async () => {
    const { peer, agent } = fixture()
    const rejected = expect(peer.request('wait', {})).rejects.toMatchObject({ code: -32603 })
    agent.stdout.write('{"jsonrpc":"2.0","id":1}\n')
    await rejected
    const contradictory = expect(peer.request('wait', {})).rejects.toMatchObject({ code: -32603 })
    agent.stdout.write('{"jsonrpc":"2.0","id":2,"result":"x","error":{"code":1,"message":"y"}}\n')
    await contradictory
  })

  it('rejects all pending calls on exit and stops accepting requests', async () => {
    const onClose = vi.fn()
    const { peer, agent } = fixture({ onClose })
    const first = expect(peer.request('first', {})).rejects.toBeInstanceOf(AcpConnectionClosedError)
    const second = expect(peer.request('second', {})).rejects.toBeInstanceOf(
      AcpConnectionClosedError
    )
    agent.stdout.end()
    await Promise.all([first, second])
    peer.close()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(agent.stdout.listenerCount('data')).toBe(0)
    await expect(peer.request('late', {})).rejects.toBeInstanceOf(AcpConnectionClosedError)
  })

  it('bounds pending calls and frees capacity when a request times out', async () => {
    vi.useFakeTimers()
    const { peer, agent } = fixture({}, { maxPendingRequests: 1, requestTimeoutMs: 20 })
    const timedOut = expect(peer.request('wait', {})).rejects.toBeInstanceOf(AcpRequestTimeoutError)
    await expect(peer.request('overflow', {})).rejects.toThrow('capacity exceeded')
    await vi.advanceTimersByTimeAsync(20)
    await timedOut
    agent.on('next', (frame) => agent.reply(frame, 'ok'))
    expect(await peer.request('next', {})).toBe('ok')
    expect(agent.frames.map((frame) => frame.method)).toEqual(['wait', 'next'])
  })

  it('bounds incoming requests without expiring user decisions', async () => {
    vi.useFakeTimers()
    const signal = deferred<AbortSignal>()
    const answer = deferred<unknown>()
    const { agent } = fixture(
      {
        onRequest: (_method, _params, context) => {
          signal.resolve(context.signal)
          return answer.promise
        }
      },
      { maxIncomingRequests: 1, requestTimeoutMs: 20 }
    )
    const first = agent.request('first', '_question', {})
    const context = await signal.promise
    expect(await agent.request('overflow', '_question', {})).toMatchObject({
      error: { code: -32603 }
    })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(context.aborted).toBe(false)
    answer.resolve({ answer: true })
    expect(await first).toMatchObject({ result: { answer: true } })
    expect(await agent.request('next', '_question', {})).toMatchObject({ result: { answer: true } })
  })

  it('aborts an in-flight incoming hook on close and never writes its late response', async () => {
    const entered = deferred<AbortSignal>()
    const result = deferred<unknown>()
    const { peer, agent } = fixture({
      onRequest: (_method, _params, context) => {
        entered.resolve(context.signal)
        return result.promise
      }
    })
    void agent.request('open', '_question', {})
    const signal = await entered.promise
    peer.close()
    expect(signal.aborted).toBe(true)
    result.resolve({ late: true })
    await tick()
    expect(agent.frames).toEqual([])
  })

  it('serializes writes through backpressure and bounds queued output', async () => {
    const writes: string[] = []
    const callbacks: ((error?: Error | null) => void)[] = []
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString())
        callbacks.push(callback)
      }
    })
    const input = new PassThrough()
    const peer = new AcpJsonRpcPeer(input, output, {}, { maxQueuedWriteBytes: 170 })
    peers.push(peer)
    const first = peer.notify('one', {})
    const second = peer.notify('two', {})
    const third = peer.notify('three', {})
    await expect(peer.notify('overflow', {})).rejects.toThrow('capacity exceeded')
    expect(writes).toHaveLength(1)
    callbacks[0]()
    await first
    expect(writes).toHaveLength(2)
    callbacks[1]()
    await second
    callbacks[2]()
    await third
    expect(writes.map((line) => JSON.parse(line).method)).toEqual(['one', 'two', 'three'])
    peer.close()
    input.destroy()
    output.destroy()
  })

  it('rejects active and queued writes when output closes', async () => {
    const input = new PassThrough()
    const output = new Writable({ write(_chunk, _encoding, _callback) {} })
    const peer = new AcpJsonRpcPeer(input, output)
    peers.push(peer)
    const first = expect(peer.notify('one', {})).rejects.toBeInstanceOf(AcpConnectionClosedError)
    const second = expect(peer.request('two', {})).rejects.toBeInstanceOf(AcpConnectionClosedError)
    output.destroy()
    await Promise.all([first, second])
    input.destroy()
  })

  it('removes a timed-out queued request before it can reach the agent', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const callbacks: ((error?: Error | null) => void)[] = []
    const input = new PassThrough()
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString())
        callbacks.push(callback)
      }
    })
    const peer = new AcpJsonRpcPeer(input, output, {}, { requestTimeoutMs: 20 })
    peers.push(peer)
    const first = peer.notify('hold', {})
    const timedOut = expect(peer.request('must-not-arrive', {})).rejects.toBeInstanceOf(
      AcpRequestTimeoutError
    )
    await vi.advanceTimersByTimeAsync(20)
    await timedOut
    callbacks[0]()
    await first
    expect(writes.map((line) => JSON.parse(line).method)).toEqual(['hold'])
    peer.close()
    input.destroy()
    output.destroy()
  })

  it('fails pending requests on an output stream error', async () => {
    const { peer, agent } = fixture()
    const rejected = expect(peer.request('wait', {})).rejects.toThrow('Broken pipe')
    agent.stdin.emit('error', new Error('Broken pipe'))
    await rejected
    expect(peer.closed).toBe(true)
  })

  it('handles asynchronous write callback errors without an unhandled stream error', async () => {
    const input = new PassThrough()
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(new Error('Broken pipe from write')))
      }
    })
    const peer = new AcpJsonRpcPeer(input, output)
    peers.push(peer)
    await expect(peer.request('wait', {})).rejects.toThrow('Broken pipe from write')
    await tick()
    expect(peer.closed).toBe(true)
    input.destroy()
  })
})
