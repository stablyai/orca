import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isRpcDeliveryUnknown,
  markRpcDeliveryUnknown
} from '../../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../../transport/types'
import { createFakeRpcClient } from '../bridge-host-test-fakes'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_SUBSCRIPTIONS
} from './bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { BridgeClientRequests } from './bridge-client-requests'
import { BridgeReplyAssembler } from './bridge-reply-chunking'
import { createPageClient } from './bridge-page-client-test-harness'
import { createFakeBridgePortPair, type BridgePortPair } from './bridge-port-pair-test-harness'

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

  // Page normalization hides raw input from the host; inject an unnormalized frame too so both endpoints’ use of the shared URL rule is tested.
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
  expect(pair.rpc.requests[0]!.args).toEqual(['status.get', undefined, { timeoutMs: 50 }])
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
  const dropped = pair.client
    .sendRequest('status.get', undefined, { signal: new AbortController().signal, timeoutMs: 50 })
    .catch((error) => error)
  await pair.flush()
  await vi.advanceTimersByTimeAsync(51)
  expect((await dropped).message).toContain('timed out')
  pair.client.close()
  pair.host.dispose()
})

describe('private bridge response completion', () => {
  it.each([new Error('original reason'), 'not an Error'])(
    'preserves the pre-send abort policy for %s',
    (reason) => {
      const page = createPageClient()
      page.start()
      const readyFrames = page.frames()
      expect(readyFrames).toHaveLength(1)
      expect(readyFrames[0]).toMatchObject({ v: 1, type: 'ready' })
      const controller = new AbortController()
      controller.abort(reason)
      const beforeSend = vi.fn()
      try {
        page.client.sendRequest('status.get', undefined, { signal: controller.signal, beforeSend })
        throw new Error('preabort must throw')
      } catch (error) {
        if (reason instanceof Error) {
          expect(error).toBe(reason)
        } else {
          expect(error).toMatchObject({ name: 'AbortError', message: 'The operation was aborted.' })
        }
      }
      expect(beforeSend).not.toHaveBeenCalled()
      expect(page.frames()).toEqual(readyFrames)
      page.client.close()
    }
  )

  it.each(['beforeSend', 'send', 'listener'] as const)(
    'observes raw rejection when abort occurs during %s',
    async (at) => {
      const controller = new AbortController()
      const page = createPageClient({
        send: (json) => {
          if (at === 'send' && JSON.parse(json).type === 'request') {
            controller.abort(new Error('private reason'))
          }
        }
      })
      page.start()
      if (at === 'listener') {
        const add = controller.signal.addEventListener.bind(controller.signal)
        vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => {
          controller.abort()
          add(...args)
        })
      }
      const answer = page.client.sendRequest('status.get', undefined, {
        signal: controller.signal,
        beforeSend: () => {
          if (at === 'beforeSend') {
            controller.abort()
          }
        }
      })
      await expect(answer).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Promise settlement wait aborted'
      })
      expect(page.frames().map((frame) => frame.type)).toEqual(['ready', 'request', 'cancel'])
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      page.client.close()
      vi.restoreAllMocks()
    }
  )

  it.each([false, true])('keeps reply-before-reaction abort ordering (abort=%s)', async (abort) => {
    const controller = new AbortController()
    const response = success('physical', { exact: true })
    const page = createPageClient({
      send: (json) => {
        const frame = JSON.parse(json)
        if (frame.type === 'request') {
          page.deliver({ v: 1, type: 'reply', id: frame.id, payload: response })
        }
      }
    })
    page.start()
    const answer = page.client.sendRequest('status.get', undefined, { signal: controller.signal })
    if (abort) {
      controller.abort(new Error('ignored by signaled bridge'))
      await expect(answer).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Promise settlement wait aborted'
      })
    } else {
      await expect(answer).resolves.toEqual(response)
      controller.abort()
    }
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toHaveLength(abort ? 1 : 0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    page.client.close()
  })

  it.each(['send', 'oversized', 'envelope'] as const)(
    'preserves %s failure versus same-turn abort',
    async (failure) => {
      for (const abort of [false, true]) {
        const controller = new AbortController()
        const page = createPageClient({
          send: (json) => {
            if (failure === 'send' && JSON.parse(json).type === 'request') {
              throw new Error('port down')
            }
          }
        })
        page.start()
        const answer = page.client.sendRequest(
          'status.get',
          failure === 'oversized' ? 'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES) : undefined,
          {
            signal: controller.signal,
            ...(failure === 'envelope' ? { envelope: { executionHost: 'runtime:a' } } : {})
          }
        )
        if (abort) {
          controller.abort()
        }
        await expect(answer).rejects.toMatchObject(
          abort
            ? { name: 'AbortError', message: 'Promise settlement wait aborted' }
            : {
                name:
                  failure === 'send'
                    ? 'BridgeSendFailedError'
                    : failure === 'oversized'
                      ? 'BridgeRequestOversizedError'
                      : 'BridgeRpcEnvelopeUngrantedError'
              }
        )
        expect(page.frames().filter((frame) => frame.type === 'cancel')).toHaveLength(abort ? 1 : 0)
        expect(vi.getTimerCount()).toBe(0)
        page.client.close()
      }
    }
  )

  it.each([undefined, 0, -2, 7])(
    'keeps the signaled deadline default/clamp for %s',
    async (timeoutMs) => {
      const page = createPageClient()
      page.start()
      const controller = new AbortController()
      const answer = page.client
        .sendRequest('status.get', undefined, { signal: controller.signal, timeoutMs })
        .catch(readError)
      const deadline = Math.max(1, timeoutMs ?? 30_000)
      await vi.advanceTimersByTimeAsync(deadline - 1)
      expect(page.sent.filter((json) => JSON.parse(json).type === 'cancel')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(readError(await answer).message).toBe('Promise settlement wait timed out')
      expect(page.sent.filter((json) => JSON.parse(json).type === 'cancel')).toHaveLength(1)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      page.client.close()
    }
  )

  it('returns the identical unobserved raw response without signal, even with a timeout', async () => {
    const requests = new BridgeClientRequests()
    let settle = (_value: RpcResponse) => {}
    const raw = new Promise<RpcResponse>((resolve) => {
      settle = resolve
    })
    const observe = vi.spyOn(raw, 'then')
    const cancel = vi.fn()
    expect(requests.wait('no-signal', raw, { timeoutMs: 1 }, cancel)).toBe(raw)
    expect(observe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(30_001)
    expect(cancel).not.toHaveBeenCalled()
    const result = success('no-signal', 'original')
    settle(result)
    expect(await raw).toBe(result)
  })

  it.each(['failure', 'close'] as const)(
    'delivers original %s identity on the raw reaction, then ignores abort',
    async (end) => {
      const requests = new BridgeClientRequests()
      const raw = new Promise<RpcResponse>((resolve, reject) =>
        requests.open('identity', { resolve, reject })
      )
      const controller = new AbortController()
      const cancel = vi.fn()
      const error = new Error('original terminal error')
      const answer = requests
        .wait('identity', raw, { signal: controller.signal }, cancel)
        .catch(readError)
      if (end === 'failure') {
        requests.fail('identity', error)
      } else {
        requests.closeAll(error)
      }
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
      expect(await answer).toBe(error)
      if (end === 'close') {
        expect(isRpcDeliveryUnknown(error)).toBe(true)
      }
      controller.abort()
      expect(cancel).not.toHaveBeenCalled()
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([1, 10].flatMap((count) => ['abort', 'deadline'].map((end) => ({ count, end }))))(
    'bounds $count $end private responses separately from live B and output',
    async ({ count, end }) => {
      const requests = new BridgeClientRequests()
      const discard = vi.spyOn(BridgeReplyAssembler.prototype, 'discard')
      const cancel = vi.fn()
      const active = Array.from({ length: count + 1 }, (_, index) => {
        const controller = new AbortController()
        const raw = new Promise<RpcResponse>((resolve, reject) =>
          requests.open(String(index), { resolve, reject })
        )
        const observe = vi.spyOn(raw, 'then')
        const answer = requests
          .wait(
            String(index),
            raw,
            { signal: controller.signal, timeoutMs: index === count ? 100 : 50 },
            cancel
          )
          .catch(readError)
        expect(observe).toHaveBeenCalledOnce()
        return { controller, answer, reaction: observe.mock.results[0]?.value }
      })
      expect(requests.size).toBe(count + 1)
      expect(vi.getTimerCount()).toBe(count + 1)
      expect(
        active.map(({ controller }) => getEventListeners(controller.signal, 'abort').length)
      ).toEqual(Array(count + 1).fill(1))
      for (let index = 0; index < count; index++) {
        requests.acceptReply({
          v: 1,
          type: 'reply',
          id: String(index),
          part: { i: 0, of: 2 },
          chunk: '{'
        })
        if (end === 'abort') {
          active[index]!.controller.abort()
        }
      }
      if (end === 'deadline') {
        await vi.advanceTimersByTimeAsync(50)
      }
      expect(requests.size).toBe(1)
      expect(vi.getTimerCount()).toBe(1)
      expect(cancel).toHaveBeenCalledTimes(count)
      expect(discard).toHaveBeenCalledTimes(count)
      await Promise.all(active.slice(0, count).map(({ answer }) => answer))
      expect(await Promise.all(active.slice(0, count).map(({ reaction }) => reaction))).toEqual(
        Array(count).fill(undefined)
      )
      expect(
        active
          .slice(0, count)
          .every(({ controller }) => getEventListeners(controller.signal, 'abort').length === 0)
      ).toBe(true)
      const b = success('B', { alive: true })
      requests.acceptReply({ v: 1, type: 'reply', id: String(count), payload: b })
      expect(await active[count]!.answer).toBe(b)
      expect(await active[count]!.reaction).toBeUndefined()
      expect(requests.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      // Late parts are discarded, rather than occupying the next generation's assembler capacity.
      for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS + 1; index++) {
        requests.acceptReply({
          v: 1,
          type: 'reply',
          id: `late${index}`,
          part: { i: 0, of: 2 },
          chunk: '{'
        })
      }
      expect(discard).toHaveBeenCalledTimes(count + 1 + BRIDGE_MAX_PENDING_REQUESTS + 1)
      let finish = (_value: RpcResponse) => {}
      const freshRaw = new Promise<RpcResponse>((resolve) => {
        finish = resolve
      })
      requests.open('fresh', {
        resolve: finish,
        reject: () => {
          throw new Error('fresh assembly refused')
        }
      })
      const fresh = requests.wait('fresh', freshRaw, undefined, cancel)
      const payload = JSON.stringify(success('fresh', 'complete'))
      requests.acceptReply({
        v: 1,
        type: 'reply',
        id: 'fresh',
        part: { i: 0, of: 2 },
        chunk: payload.slice(0, 2)
      })
      requests.acceptReply({
        v: 1,
        type: 'reply',
        id: 'fresh',
        part: { i: 1, of: 2 },
        chunk: payload.slice(2)
      })
      expect(await fresh).toEqual(success('fresh', 'complete'))
      vi.restoreAllMocks()
    }
  )
})

it('keeps cancelled host physical work occupied until its actual settlement, then admits fresh work', async () => {
  const pair = await ready(createFakeBridgePortPair())
  const controllers = Array.from(
    { length: BRIDGE_MAX_PENDING_REQUESTS },
    () => new AbortController()
  )
  const pending = controllers.map((controller) =>
    pair.client.sendRequest('status.get', undefined, { signal: controller.signal }).catch(readError)
  )
  await pair.flush()
  expect(pair.rpc.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS)
  controllers[0]!.abort()
  await pair.flush()
  expect(readError(await pending[0]).name).toBe('AbortError')
  const overloaded = pair.client.sendRequest('status.get').catch(readError)
  await pair.flush()
  expect(readError(await overloaded).name).toBe('BridgeCapExceededError')
  expect(pair.rpc.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS)
  pair.rpc.requests[1]!.resolve(success('B', { survivor: true }))
  await pair.flush()
  expect(await pending[1]).toEqual(success('B', { survivor: true }))
  pair.rpc.requests[0]!.resolve(success('late-A', { obsolete: true }))
  await pair.flush()
  const next = pair.client.sendRequest('status.get')
  await pair.flush()
  pair.rpc.requests.at(-1)!.resolve(success('fresh', { next: true }))
  await pair.flush()
  expect(await next).toEqual(success('fresh', { next: true }))
  pair.client.close()
  pair.host.dispose()
  await Promise.all(pending)
})
