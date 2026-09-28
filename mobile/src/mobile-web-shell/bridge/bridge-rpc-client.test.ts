import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isRpcDeliveryUnknown,
  markRpcDeliveryUnknown
} from '../../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../../transport/types'
import { createFakeRpcClient } from '../bridge-host-test-fakes'
import { BRIDGE_MAX_MESSAGE_BYTES, BRIDGE_MAX_SUBSCRIPTIONS } from './bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { createFakeBridgePortPair, type BridgePortPair } from './bridge-port-pair-test-harness'

/**
 * The page's client and the shell's host, over one FIFO per direction.
 *
 * That `createBridgeRpcClient` returns an `RpcClient` is the type system's job and it is already
 * done; what a test has to prove is that each member still means the same thing after a round trip,
 * because the screens above it cannot tell which client they are holding.
 */

function success(id: string, result: unknown): RpcResponse {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

/** Narrows what a rejection handed back, so a test reads an error rather than asserting one. */
function readError(thrown: unknown): Error {
  if (!(thrown instanceof Error)) {
    throw new Error(`expected an Error, got ${typeof thrown}`)
  }
  return thrown
}

async function ready(pair: BridgePortPair): Promise<BridgePortPair> {
  await pair.flush()
  return pair
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bridge round trip: requests', () => {
  it('reaches the shell with the arity the page called with', async () => {
    const pair = await ready(createFakeBridgePortPair())
    void pair.client.sendRequest('worktree.ps')
    void pair.client.sendRequest('worktree.ps', { host: 'a' })
    void pair.client.sendRequest('worktree.ps', { host: 'a' }, { timeoutMs: 50 })
    await pair.flush()
    expect(pair.rpc.requests.map((request) => request.args)).toEqual([
      ['worktree.ps'],
      ['worktree.ps', { host: 'a' }],
      ['worktree.ps', { host: 'a' }, { timeoutMs: 50 }]
    ])
  })

  it('resolves the response the shell answered with, field for field', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const answer = pair.client.sendRequest('worktree.ps')
    await pair.flush()
    const response: RpcResponse = {
      id: 'shell-side-id',
      ok: true,
      result: { rows: [1, 2, 3] },
      streaming: true,
      _meta: { runtimeId: 'runtime-a' }
    }
    pair.rpc.requests[0]?.resolve(response)
    await pair.flush()
    await expect(answer).resolves.toEqual(response)
  })

  it('resolves a host failure, because a failure is data and not a rejection', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const answer = pair.client.sendRequest('worktree.ps')
    await pair.flush()
    const failure: RpcResponse = {
      id: 'shell-side-id',
      ok: false,
      error: { code: 'not_found', message: 'no such worktree', data: { host: 'a' } },
      _meta: { runtimeId: 'runtime-a' }
    }
    pair.rpc.requests[0]?.resolve(failure)
    await pair.flush()
    await expect(answer).resolves.toEqual(failure)
  })

  it('rejects with the class, the code and the delivery mark the shell captured', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const answer = pair.client.sendRequest('worktree.ps')
    await pair.flush()
    class RpcTimeoutError extends Error {
      code = 'ETIMEDOUT'
    }
    const thrown = markRpcDeliveryUnknown(new RpcTimeoutError('timed out after 50ms'))
    thrown.cause = new Error('socket closed')
    pair.rpc.requests[0]?.reject(thrown)
    await pair.flush()
    const error = await answer.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(readError(error).name).toBe('RpcTimeoutError')
    expect(readError(error).message).toBe('timed out after 50ms')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    expect(readError(readError(error).cause).message).toBe('socket closed')
  })

  it('reassembles a reply too big for one frame', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const answer = pair.client.sendRequest('source-control.diff')
    await pair.flush()
    const result = { diff: 'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES + 60_000) }
    pair.rpc.requests[0]?.resolve(success('shell-side-id', result))
    await pair.flush()
    await expect(answer).resolves.toEqual(success('shell-side-id', result))
    expect(pair.toPage.length).toBeGreaterThan(2)
  })
})

describe('bridge round trip: subscriptions', () => {
  it('streams what the shell emits and stops when the page disposes', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const onData = vi.fn()
    const dispose = pair.client.subscribe('terminal.stream', { terminal: 't' }, onData)
    await pair.flush()
    expect(pair.rpc.streams[0]?.method).toBe('terminal.stream')
    expect(pair.rpc.streams[0]?.params).toEqual({ terminal: 't' })
    pair.rpc.streams[0]?.emit({ type: 'data', chunk: 'hello' })
    await pair.flush()
    expect(onData).toHaveBeenCalledWith({ type: 'data', chunk: 'hello' })
    dispose()
    await pair.flush()
    expect(pair.rpc.streams[0]?.unsubscribes).toBe(1)
    pair.rpc.streams[0]?.emit({ type: 'data', chunk: 'after' })
    await pair.flush()
    expect(onData).toHaveBeenCalledTimes(1)
  })

  it('frees the page slot when the shell refuses the subscribe', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const onData = vi.fn()
    const refuse = vi.spyOn(pair.rpc, 'subscribe').mockImplementation(() => {
      throw new Error('the terminal is gone')
    })
    pair.client.subscribe('terminal.stream', { terminal: 't' }, onData)
    await pair.flush()
    refuse.mockRestore()
    expect(pair.diagnostics).toEqual([
      { kind: 'stream-failed', error: expect.objectContaining({ message: 'the terminal is gone' }) }
    ])
    // The shell's own message reaches the listener, the way the native client passes one through.
    expect(onData.mock.calls).toEqual([
      [{ type: 'error', message: 'the terminal is gone', error: expect.any(Error) }]
    ])
    // A leaked slot is invisible until the page reaches its own cap, so that is where it is read.
    for (let index = 0; index < BRIDGE_MAX_SUBSCRIPTIONS; index += 1) {
      pair.client.subscribe('terminal.stream', {}, vi.fn())
    }
    await pair.flush()
    expect(pair.rpc.streams).toHaveLength(BRIDGE_MAX_SUBSCRIPTIONS)
  })

  it('keeps a long stream alive, because the acks free the shell window', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const onData = vi.fn()
    pair.client.subscribe('terminal.stream', {}, onData)
    await pair.flush()
    for (let batch = 0; batch < 8; batch += 1) {
      for (let frame = 0; frame < 50; frame += 1) {
        pair.rpc.streams[0]?.emit(`frame-${batch}-${frame}`)
      }
      await pair.flush()
    }
    expect(onData).toHaveBeenCalledTimes(400)
    expect(pair.diagnostics).toEqual([])
  })

  it('ends the stream when the page never gets a chance to ack', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const onData = vi.fn()
    pair.client.subscribe('terminal.stream', {}, onData)
    await pair.flush()
    for (let frame = 0; frame < 400; frame += 1) {
      pair.rpc.streams[0]?.emit(`frame-${frame}`)
    }
    await pair.flush()
    expect(pair.diagnostics).toEqual([{ kind: 'stream-ended', reason: 'overflow' }])
    expect(onData.mock.calls.length).toBeLessThan(400)
  })
})

describe('bridge round trip: notifications and state', () => {
  it('carries both notifies to the shell client, with the arity each was called with', async () => {
    const pair = await ready(createFakeBridgePortPair())
    pair.client.notifyForeground()
    pair.client.notifyForeground('app-resume')
    pair.client.updateTerminalSubscriptionViewport('terminal-a', { cols: 120, rows: 40 })
    await pair.flush()
    expect(pair.rpc.foregroundCalls).toEqual([[], ['app-resume']])
    expect(pair.rpc.viewports).toEqual([{ terminal: 'terminal-a', cols: 120, rows: 40 }])
  })

  it('asks the shell to open a screen the page does not render', async () => {
    const pair = await ready(createFakeBridgePortPair())
    expect(pair.client.notifyNavigate('/h/host-a/session/wt-1?name=a+b')).toBe(true)
    await pair.flush()
    expect(pair.navigations).toEqual(['/h/host-a/session/wt-1?name=a+b'])
    // One way: the page hears nothing back, and nothing about it reaches the shell's client.
    expect(pair.rpc.requests).toEqual([])
  })

  /**
   * The page's normalization and the host's are separate calls on the same rule, and the frame in
   * between is the only place they could disagree.
   *
   * Two halves, because the first cannot see the second: the page normalizes before it posts, so
   * over the client the host only ever receives an already-normalized URL and forwarding it raw
   * would pass. The injected frame at the end is what holds the host to the rule on its own.
   */
  it('asks the shell to open a URL outside the app, normalized once and the same on both sides', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const inputs = [
      'https://github.com/stablyai/orca/pull/1',
      'ht\ntps://example.com',
      'https://example.com/a\r\n',
      '  https://example.com/a  ',
      'https:example.com',
      'mailto:someone@example.com'
    ]
    for (const url of inputs) {
      expect(pair.client.notifyExternalLink(url), url).toBe(true)
    }
    await pair.flush()
    // Byte-equal to what the page put on the wire, read back off the frames rather than recomputed.
    const posted = pair.toShell
      .map((json: string) => JSON.parse(json))
      .filter((frame: { name?: string }) => frame.name === 'externalLink')
      .map((frame: { url: string }) => frame.url)
    expect(pair.externalLinks).toEqual(posted)
    expect(posted).toEqual([
      'https://github.com/stablyai/orca/pull/1',
      'https://example.com/',
      'https://example.com/a',
      'https://example.com/a',
      'https://example.com/',
      'mailto:someone@example.com'
    ])
    // The host's own half: a frame the page client never shaped, delivered straight to the host.
    pair.host.receive(
      JSON.stringify({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'externalLink',
        url: '  https://example.com/b\r\n  '
      })
    )
    await pair.flush()
    expect(pair.externalLinks.at(-1)).toBe('https://example.com/b')
    // One way: the page hears nothing back, and nothing about it reaches the shell's client.
    expect(pair.rpc.requests).toEqual([])
  })

  it('refuses a URL outside the grant without putting a frame on the wire', async () => {
    const pair = await ready(createFakeBridgePortPair())
    expect(pair.client.notifyExternalLink('javascript:alert(1)')).toBe(false)
    await pair.flush()
    expect(pair.externalLinks).toEqual([])
    expect(pair.hostDiagnostics).toEqual([])
  })

  it('reads the shell client through init and fans out every change after it', async () => {
    const rpc = createFakeRpcClient({
      getState: () => 'reconnecting',
      getReconnectAttempt: () => 3,
      getLastConnectedAt: () => 1234,
      getLastInboundAt: () => 5678,
      getGeneration: () => 9
    })
    const pair = await ready(createFakeBridgePortPair({ rpc }))
    expect(pair.client.getState()).toBe('reconnecting')
    expect(pair.client.getReconnectAttempt()).toBe(3)
    expect(pair.client.getLastConnectedAt()).toBe(1234)
    expect(pair.client.getLastInboundAt?.()).toBe(5678)
    expect(pair.client.getGeneration?.()).toBe(9)
    const listener = vi.fn()
    const release = pair.client.onStateChange(listener)
    rpc.pushState('connected')
    await pair.flush()
    expect(listener).toHaveBeenCalledWith('connected')
    expect(pair.client.getState()).toBe('connected')
    release()
    rpc.pushState('disconnected')
    await pair.flush()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('refuses a snapshot from a shell that was rebuilt, and asks for a fresh init', async () => {
    let generation = 5
    const rpc = createFakeRpcClient({ getGeneration: () => generation })
    const pair = await ready(createFakeBridgePortPair({ rpc }))
    const listener = vi.fn()
    pair.client.onStateChange(listener)
    const asked = pair.readToShell().filter((frame) => frame.type === 'ready').length
    generation = 2
    rpc.pushState('reconnecting')
    await pair.flush()
    expect(pair.diagnostics).toEqual([{ kind: 'state-out-of-order' }])
    expect(listener).not.toHaveBeenCalled()
    expect(pair.readToShell().filter((frame) => frame.type === 'ready').length).toBe(asked + 1)
    // The fresh init is what re-primes the cache; the refused frame never touched it.
    expect(pair.client.getState()).toBe('connected')
    expect(pair.client.getGeneration?.()).toBe(2)
  })
})

describe('bridge round trip: close', () => {
  it('settles pendings delivery-unknown, retires the streams, and leaves the shell client open', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const closeShellClient = vi.spyOn(pair.rpc, 'close')
    const answer = pair.client.sendRequest('worktree.ps')
    pair.client.subscribe('terminal.stream', {}, vi.fn())
    await pair.flush()
    pair.client.close()
    const error = await answer.catch((caught: unknown) => caught)
    expect(readError(error).name).toBe('BridgeClientClosedError')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    await pair.flush()
    expect(pair.rpc.streams[0]?.unsubscribes).toBe(1)
    expect(closeShellClient).not.toHaveBeenCalled()
    expect(pair.readToShell().at(-1)).toEqual({ v: 1, type: 'close' })
  })
})
