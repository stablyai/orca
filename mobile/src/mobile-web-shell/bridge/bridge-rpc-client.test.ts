import { getRemoteRuntimeRequestAdmissionEvidence } from '../../../../src/shared/remote-runtime/requests/remote-runtime-prepared-request-admission'
import { RpcClientRequestTracker } from '../../transport/rpc-client-request-tracker'
import type { RpcRequestFrame } from '../../transport/rpc-envelope-fields'
import type { RpcResponse } from '../../transport/types'
import type { BridgePortPair } from './bridge-port-pair-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isRpcDeliveryUnknown,
  markRpcDeliveryUnknown
} from '../../transport/rpc-delivery-ambiguity'

import { createFakeRpcClient, shellLocalCall } from '../bridge-host-test-fakes'
import { BRIDGE_MAX_MESSAGE_BYTES, BRIDGE_MAX_SUBSCRIPTIONS } from './bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { bridgeOrdinaryBackstopMs } from './bridge-client-requests'

import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'

// Test RpcClient behavior across real FIFO bridge lanes; type conformance alone cannot prove screens observe the same round-trip semantics.

function success(id: string, result: unknown): RpcResponse {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

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
    expect(pair.rpc.requests.map((request) => shellLocalCall(request.args))).toEqual([
      ['worktree.ps', undefined, {}, 'function'],
      ['worktree.ps', { host: 'a' }, {}, 'function'],
      ['worktree.ps', { host: 'a' }, { timeoutMs: 50 }, 'function']
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
    expect(error).toMatchObject({ code: 'ETIMEDOUT' })
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
    expect(onData.mock.calls).toEqual([
      [{ type: 'error', message: 'the terminal is gone', error: expect.any(Error) }]
    ])
    // Reach the in-flight cap to expose a leaked slot.
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
    expect(onData.mock.calls.map(([payload]) => payload)).toEqual(
      Array.from({ length: 8 }, (_, batch) =>
        Array.from({ length: 50 }, (_, frame) => `frame-${batch}-${frame}`)
      ).flat()
    )
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
    expect(pair.rpc.requests).toEqual([])
  })

  // Capable sender and receiver preserve original strings after the same scheme check.
  it('asks the shell to open the exact original URL outside the app', async () => {
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
    const posted = pair.toShell
      .map((json: string) => JSON.parse(json))
      .filter((frame: { name?: string }) => frame.name === 'externalLink')
      .map((frame: { url: string }) => frame.url)
    expect(pair.externalLinks).toEqual(posted)
    expect(posted).toEqual(inputs)
    pair.host.receive(
      JSON.stringify({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'externalLink',
        url: '  https://example.com/b\r\n  '
      })
    )
    await pair.flush()
    expect(pair.externalLinks.at(-1)).toBe('  https://example.com/b\r\n  ')
    expect(pair.rpc.requests).toEqual([])
  })

  it('refuses a URL outside the grant without putting a frame on the wire', async () => {
    const pair = await ready(createFakeBridgePortPair())
    const sent = pair.toShell.length
    expect(pair.client.notifyExternalLink('javascript:alert(1)')).toBe(false)
    await pair.flush()
    expect(pair.toShell).toHaveLength(sent)
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
    expect(pair.client.getState()).toBe('connected')
    expect(pair.client.getGeneration?.()).toBe(2)
  })
})

// The shell answered and split a large reply; lost native posts leave the page waiting on its backstop.
describe('bridge round trip: lost replies', () => {
  it.each([
    {
      lost: 'the final reply frame',
      drop: (part?: { i: number; of: number }) => part !== undefined && part.i === part.of - 1
    },
    { lost: 'every reply frame', drop: () => true }
  ])('settles once, unknown, and cancels once when $lost never arrives', async ({ drop }) => {
    const baseline = getRemoteRuntimeRequestAdmissionEvidence()
    const held: string[] = []
    const pair = await ready(
      createFakeBridgePortPair({
        holdToPage: (json) => {
          const frame: { type: string; part?: { i: number; of: number } } = JSON.parse(json)
          return frame.type === 'reply' && drop(frame.part) && held.push(json) > 0
        }
      })
    )
    let settled = false
    const answer = pair.client
      .sendRequest('worktree.ps', undefined, { timeoutMs: 50 })
      .catch((error: unknown) => error)
      .finally(() => (settled = true))
    await pair.flush()
    expect(getRemoteRuntimeRequestAdmissionEvidence()).not.toEqual(baseline)
    pair.rpc.requests[0]!.resolve(success('large', 'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES)))
    await pair.flush()
    // The shell posted every part and released its lease; only delivery was lost.
    expect(pair.toPage.filter((json) => json.includes('"part"')).length).toBeGreaterThan(1)
    expect(held.length).toBeGreaterThan(0)
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(baseline)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(bridgeOrdinaryBackstopMs(50) - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await answer
    expect(readError(error).message).toBe('Request timed out: worktree.ps')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    await pair.flush()
    expect(pair.readToShell().filter((frame) => frame.type === 'cancel')).toHaveLength(1)
    // Late parts find no request: no second settlement, no new request.
    held.forEach((json) => pair.deliverToPage(json))
    await pair.flush()
    expect(pair.rpc.requests).toHaveLength(1)
    expect(pair.readToShell().filter((frame) => frame.type === 'cancel')).toHaveLength(1)
    pair.client.close()
    pair.host.dispose()
  })
})

// The shell's production tracker behind a connection the test opens: a request may wait to connect.
function queuedShell() {
  const frames: RpcRequestFrame[] = []
  const waiters: (() => void)[] = []
  let connected = false
  let nextId = 0
  const tracker = new RpcClientRequestTracker({
    nextId: () => `physical-${++nextId}`,
    getState: () => (connected ? 'connected' : 'connecting'),
    waitForConnected: () =>
      connected ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)),
    sendFrame: (frame) => frames.push(frame) > 0
  })
  const rpc = createFakeRpcClient()
  rpc.sendRequest = (...args) => tracker.sendRequest(...args)
  const reconnect = () => {
    connected = true
    waiters.splice(0).forEach((resolve) => resolve())
  }
  return { rpc, tracker, frames, reconnect }
}

describe('bridge round trip: queued ordinary requests', () => {
  it('never sends a queued request the page gave up on, and sends its successor once', async () => {
    const baseline = getRemoteRuntimeRequestAdmissionEvidence()
    const shell = queuedShell()
    const pair = await ready(createFakeBridgePortPair({ rpc: shell.rpc }))
    const abandoned = pair.client.sendRequest('worktree.ps').catch((error: unknown) => error)
    await pair.flush()
    await vi.advanceTimersByTimeAsync(bridgeOrdinaryBackstopMs(30_000))
    const error = await abandoned
    expect(readError(error).message).toBe('Request timed out: worktree.ps')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    await pair.flush()
    expect(pair.readToShell().filter((frame) => frame.type === 'cancel')).toHaveLength(1)
    shell.reconnect()
    await pair.flush()
    expect(shell.frames).toEqual([])
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(baseline)
    const successor = pair.client.sendRequest('worktree.ps')
    await pair.flush()
    expect(shell.frames.map((frame) => frame.method)).toEqual(['worktree.ps'])
    shell.tracker.resolve(success(shell.frames[0]!.id, 'next'))
    await pair.flush()
    expect(await successor).toEqual(success(shell.frames[0]!.id, 'next'))
    expect(shell.frames).toHaveLength(1)
    expect(shell.tracker.size()).toBe(0)
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual(baseline)
    pair.client.close()
    pair.host.dispose()
  })

  it('answers a connect-then-response that crosses T inside the shell budget', async () => {
    const shell = queuedShell()
    const pair = await ready(createFakeBridgePortPair({ rpc: shell.rpc }))
    const answer = pair.client.sendRequest('worktree.ps', undefined, { timeoutMs: 50 })
    await pair.flush()
    await vi.advanceTimersByTimeAsync(45)
    shell.reconnect()
    await pair.flush()
    await vi.advanceTimersByTimeAsync(40)
    shell.tracker.resolve(success(shell.frames[0]!.id, 'slow'))
    await pair.flush()
    expect(await answer).toEqual(success(shell.frames[0]!.id, 'slow'))
    expect(pair.readToShell().filter((frame) => frame.type === 'cancel')).toEqual([])
    pair.client.close()
    pair.host.dispose()
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

it('keeps source signals local, cancels only the abandoned waiter and preserves an old-shell request frame', async () => {
  const pair = await ready(createFakeBridgePortPair())
  const controller = new AbortController()
  const beforeSend = vi.fn()
  const pending = pair.client
    .sendRequest('status.get', undefined, { signal: controller.signal, beforeSend, timeoutMs: 50 })
    .catch((error) => error)
  await pair.flush()
  expect(beforeSend).toHaveBeenCalledOnce()
  expect(shellLocalCall(pair.rpc.requests[0]!.args)).toEqual([
    'status.get',
    undefined,
    { timeoutMs: 50 },
    'function'
  ])
  expect(
    pair.toShell.some((frame) => frame.includes('signal') || frame.includes('beforeSend'))
  ).toBe(false)
  controller.abort()
  expect((await pending).name).toBe('AbortError')
  await pair.flush()
  expect(pair.readToShell().some((frame) => frame.type === 'cancel')).toBe(true)
  pair.rpc.requests[0]!.resolve(success('late35636', { old: true }))
  const successor = pair.client.sendRequest('status.get', undefined, {
    signal: new AbortController().signal,
    timeoutMs: 50
  })
  await pair.flush()
  pair.rpc.requests[1]!.resolve(success('retry35636', { next: true }))
  await pair.flush()
  expect(await successor).toEqual(success('retry35636', { next: true }))
  // The shell owns the deadline: its answer after T still reaches a signal-bearing caller.
  const slow = pair.client.sendRequest('status.get', undefined, {
    signal: new AbortController().signal,
    timeoutMs: 50
  })
  await pair.flush()
  await vi.advanceTimersByTimeAsync(60)
  pair.rpc.requests[2]!.resolve(success('slow35636', { slow: true }))
  await pair.flush()
  expect(await slow).toEqual(success('slow35636', { slow: true }))
  // A reply that never comes still settles, at the page's later backstop.
  let settled = false
  const dropped = pair.client
    .sendRequest('status.get', undefined, { signal: new AbortController().signal, timeoutMs: 50 })
    .catch((error) => error)
    .finally(() => (settled = true))
  await pair.flush()
  await vi.advanceTimersByTimeAsync(bridgeOrdinaryBackstopMs(50) - 1)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  const error = await dropped
  expect(error.message).toBe('Request timed out: status.get')
  expect(isRpcDeliveryUnknown(error)).toBe(true)
  pair.client.close()
  pair.host.dispose()
})
