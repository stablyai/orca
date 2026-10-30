import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { harness, ID, OTHER, subscribeFrame, type Harness } from './bridge-host-test-harness'
import { BRIDGE_MAX_UNACKED_BYTES, BRIDGE_MAX_UNACKED_FRAMES } from './bridge-host-subscriptions'
import {
  bridgeId,
  clientFrame,
  createFakeRpcClient,
  flushBridge,
  rpcSuccess
} from './bridge-host-test-fakes'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_REPLY_BYTES,
  BRIDGE_MAX_SUBSCRIPTIONS
} from './bridge/bridge-caps'
import type { BridgeHostMessage } from './bridge/bridge-envelope'
import { BridgeReplyAssembler } from './bridge/bridge-reply-chunking'

describe('requests', () => {
  it('replays the arity the page used', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(3), method: 'status.get', params: { a: 1 } })
    )
    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: bridgeId(4),
        method: 'status.get',
        options: { timeoutMs: 50 }
      })
    )
    expect(bridge.client.requests.map((request) => request.args)).toEqual([
      ['status.get'],
      ['status.get', { a: 1 }],
      ['status.get', undefined, { timeoutMs: 50 }]
    ])
  })

  it('carries a host failure through as data, _meta and error.data included', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    const failure: RpcResponse = {
      id: 'wire-1',
      ok: false,
      error: { code: 'not_found', message: 'gone', data: { path: '/x' } },
      _meta: { runtimeId: 'runtime-a' }
    }
    bridge.client.requests[0]?.resolve(failure)
    await flushBridge()
    expect(bridge.last()).toEqual({ v: 1, type: 'reply', id: ID, payload: failure })
  })

  it('turns a rejection into the five-field capture, delivery mark and cause included', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    const cause = new Error('socket closed')
    const error = new TypeError('send failed')
    error.cause = cause
    bridge.client.requests[0]?.reject(error)
    await flushBridge()
    expect(bridge.last()).toEqual({
      v: 1,
      type: 'error',
      id: ID,
      error: {
        category: 'TypeError',
        message: 'send failed',
        isRpcDeliveryUnknown: false,
        cause: { category: 'Error', message: 'socket closed', isRpcDeliveryUnknown: false }
      }
    })
  })

  it('answers a synchronous throw from the client and frees the slot', () => {
    const client = createFakeRpcClient()
    const bridge = harness({
      ready: true,
      client: {
        ...client,
        sendRequest: () => {
          throw new Error('no socket')
        }
      }
    })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    const errors = bridge.frames().filter((frame) => frame.type === 'error')
    expect(errors).toHaveLength(2)
    expect(
      errors.every((frame) => frame.type === 'error' && frame.error.category === 'Error')
    ).toBe(true)
  })

  it('refuses an id already in flight without settling the exchange it collided with', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'other.get' }))
    expect(bridge.client.requests).toHaveLength(1)
    expect(bridge.last().type).toBe('error')
    bridge.client.requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    expect(bridge.last()).toEqual({
      v: 1,
      type: 'reply',
      id: ID,
      payload: rpcSuccess('wire-1', 'ok')
    })
  })

  it('refuses a subscription id as a request id, because one ledger answers for both', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID))
    expect(bridge.client.streams).toHaveLength(1)
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.last()).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('already in flight') }
    })
  })

  it('admits exactly the in-flight cap and refuses the next', () => {
    const bridge = harness({ ready: true })
    for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      bridge.host.receive(
        clientFrame({ type: 'request', id: bridgeId(index), method: 'status.get' })
      )
    }
    expect(bridge.client.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS)
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([])
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(BRIDGE_MAX_PENDING_REQUESTS), method: 'x.get' })
    )
    expect(bridge.client.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS)
    expect(bridge.last().type).toBe('error')
  })

  it('reopens a slot when a request settles', async () => {
    const bridge = harness({ ready: true })
    for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      bridge.host.receive(
        clientFrame({ type: 'request', id: bridgeId(index), method: 'status.get' })
      )
    }
    bridge.client.requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(BRIDGE_MAX_PENDING_REQUESTS), method: 'x.get' })
    )
    expect(bridge.client.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS + 1)
  })

  it('holds the cap against a page that closes between batches', async () => {
    const bridge = harness({ ready: true })
    const fill = (offset: number): void => {
      for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
        bridge.host.receive(
          clientFrame({ type: 'request', id: bridgeId(offset + index), method: 'status.get' })
        )
      }
    }
    fill(0)
    expect(bridge.client.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS)
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([])
    // Desktop calls survive page close because sendRequest has no cancel; keep their 64 slots occupied instead of resetting the cap.
    bridge.host.receive(clientFrame({ type: 'close' }))
    bridge.host.receive(clientFrame({ type: 'ready' }))
    fill(100)
    expect(bridge.client.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS)
    expect(bridge.frames().filter((frame) => frame.type === 'error')).toHaveLength(
      BRIDGE_MAX_PENDING_REQUESTS
    )
    for (const request of bridge.client.requests) {
      request.resolve(rpcSuccess('wire-1', 'ok'))
    }
    await flushBridge()
    fill(200)
    expect(bridge.client.requests).toHaveLength(BRIDGE_MAX_PENDING_REQUESTS * 2)
  })

  it('stops answering a cancelled request without pretending the desktop stopped running it', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'request' }))
    bridge.client.requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([])
  })
})

describe('replies too big for one frame', () => {
  it('chunks and reassembles to the same payload', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'worktree.list' }))
    const payload = rpcSuccess('wire-1', 'y'.repeat(BRIDGE_MAX_MESSAGE_BYTES * 2))
    bridge.client.requests[0]?.resolve(payload)
    await flushBridge()
    const replies = bridge.frames()
    expect(replies.length).toBeGreaterThan(1)
    const assembler = new BridgeReplyAssembler()
    const assembled = replies.map((frame) =>
      frame.type === 'reply' ? assembler.accept(frame) : { status: 'pending' as const }
    )
    expect(assembled.at(-1)).toEqual({ status: 'complete', payload })
  })

  it('aborts the request over the reply ceiling rather than truncating an answer', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'worktree.list' }))
    bridge.client.requests[0]?.resolve(rpcSuccess('wire-1', 'y'.repeat(BRIDGE_MAX_REPLY_BYTES + 1)))
    await flushBridge()
    const frame = bridge.last()
    expect(frame.type === 'error' && frame.error).toMatchObject({
      category: 'BridgeReplyUndeliverableError',
      isRpcDeliveryUnknown: false
    })
  })
})

describe('subscriptions', () => {
  it('forwards with the arity the recorder reads and streams events from seq 1', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID))
    expect(bridge.client.streams[0]?.method).toBe('terminal.subscribe')
    bridge.client.streams[0]?.emit({ chunk: 'a' })
    bridge.client.streams[0]?.emit({ chunk: 'b' })
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([
      { v: 1, type: 'event', id: ID, seq: 1, payload: { chunk: 'a' } },
      { v: 1, type: 'event', id: ID, seq: 2, payload: { chunk: 'b' } }
    ])
  })

  it('admits exactly the subscription cap and refuses the next', () => {
    const bridge = harness({ ready: true })
    for (let index = 0; index < BRIDGE_MAX_SUBSCRIPTIONS; index += 1) {
      bridge.host.receive(subscribeFrame(bridgeId(index)))
    }
    expect(bridge.client.streams).toHaveLength(BRIDGE_MAX_SUBSCRIPTIONS)
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([])
    bridge.host.receive(subscribeFrame(bridgeId(BRIDGE_MAX_SUBSCRIPTIONS)))
    expect(bridge.client.streams).toHaveLength(BRIDGE_MAX_SUBSCRIPTIONS)
    expect(bridge.last().type).toBe('error')
  })

  it('reopens a slot when a stream is cancelled', () => {
    const bridge = harness({ ready: true })
    for (let index = 0; index < BRIDGE_MAX_SUBSCRIPTIONS; index += 1) {
      bridge.host.receive(subscribeFrame(bridgeId(index)))
    }
    bridge.host.receive(clientFrame({ type: 'cancel', id: bridgeId(0), target: 'subscription' }))
    bridge.host.receive(subscribeFrame(bridgeId(BRIDGE_MAX_SUBSCRIPTIONS)))
    expect(bridge.client.streams).toHaveLength(BRIDGE_MAX_SUBSCRIPTIONS + 1)
  })

  it('unsubscribes on cancel, says so, and delivers nothing after', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID))
    bridge.client.streams[0]?.emit({ chunk: 'a' })
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'subscription' }))
    expect(bridge.client.streams[0]?.unsubscribes).toBe(1)
    expect(bridge.last()).toEqual({ v: 1, type: 'end', id: ID, reason: 'unsubscribed' })
    bridge.client.streams[0]?.emit({ chunk: 'b' })
    expect(bridge.frames().filter((frame) => frame.type === 'event')).toHaveLength(1)
  })

  it('answers a client whose subscribe throws and holds no slot', () => {
    const client = createFakeRpcClient()
    let attempts = 0
    const bridge = harness({
      ready: true,
      client: {
        ...client,
        subscribe: () => {
          attempts += 1
          throw new Error('no socket')
        }
      }
    })
    bridge.host.receive(subscribeFrame(ID))
    expect(bridge.last().type).toBe('error')
    bridge.host.receive(subscribeFrame(ID))
    expect(attempts).toBe(2)
    expect(bridge.frames().filter((frame) => frame.type === 'error')).toEqual(
      [1, 2].map(() =>
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({ message: 'no socket' })
        })
      )
    )
  })

  it('unsubscribes a stream that overflowed inside subscribe, exactly once', () => {
    const client = createFakeRpcClient()
    let unsubscribes = 0
    const bridge = harness({
      ready: true,
      client: {
        ...client,
        subscribe: (_method, _params, onData) => {
          onData('z'.repeat(BRIDGE_MAX_MESSAGE_BYTES))
          return () => {
            unsubscribes += 1
          }
        }
      }
    })
    bridge.host.receive(subscribeFrame(ID))
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([
      { v: 1, type: 'end', id: ID, reason: 'overflow' }
    ])
    // Overflow retired this record before subscribe returned cleanup; storing unsubscribe now would leak the client stream.
    expect(unsubscribes).toBe(1)
  })
})

describe('backpressure', () => {
  // Use a nonterminal stream to test the byte window; terminal.subscribe now holds/coalesces output and tests that exception separately.
  const WINDOWED = 'session.tabs.subscribe'

  function fill(bridge: Harness, frames: number): void {
    for (let index = 0; index < frames; index += 1) {
      bridge.client.streams[0]?.emit({ n: index })
    }
  }

  it('sends exactly the unacked frame window and then ends with overflow', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID, WINDOWED))
    fill(bridge, BRIDGE_MAX_UNACKED_FRAMES)
    expect(bridge.frames().filter((frame) => frame.type === 'event')).toHaveLength(
      BRIDGE_MAX_UNACKED_FRAMES
    )
    fill(bridge, 1)
    expect(bridge.last()).toEqual({ v: 1, type: 'end', id: ID, reason: 'overflow' })
    expect(bridge.client.streams[0]?.unsubscribes).toBe(1)
  })

  it('reopens the window on ack', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID, WINDOWED))
    fill(bridge, BRIDGE_MAX_UNACKED_FRAMES)
    bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: BRIDGE_MAX_UNACKED_FRAMES }))
    fill(bridge, 1)
    const events = bridge.frames().filter((frame) => frame.type === 'event')
    expect(events).toHaveLength(BRIDGE_MAX_UNACKED_FRAMES + 1)
    expect(events.at(-1)).toMatchObject({ seq: BRIDGE_MAX_UNACKED_FRAMES + 1 })
  })

  it('acks only up to the seq it was given', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID, WINDOWED))
    fill(bridge, BRIDGE_MAX_UNACKED_FRAMES)
    bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: 1 }))
    fill(bridge, 1)
    expect(bridge.frames().filter((frame) => frame.type === 'event')).toHaveLength(
      BRIDGE_MAX_UNACKED_FRAMES + 1
    )
    fill(bridge, 1)
    expect(bridge.last()).toEqual({ v: 1, type: 'end', id: ID, reason: 'overflow' })
  })

  it('ends on the unacked byte window well before the frame window is reached', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID, WINDOWED))
    const chunk = 'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES - 1024)
    const ended = (): boolean => (bridge.posted.at(-1) ?? '').includes('"type":"end"')
    for (let index = 0; index < BRIDGE_MAX_UNACKED_FRAMES && !ended(); index += 1) {
      bridge.client.streams[0]?.emit(chunk)
    }
    const events = bridge.posted.filter((json) => JSON.parse(json).type === 'event')
    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThan(BRIDGE_MAX_UNACKED_FRAMES)
    const eventBytes = events.reduce(
      (total, json) => total + new TextEncoder().encode(json).byteLength,
      0
    )
    expect(eventBytes).toBeLessThanOrEqual(BRIDGE_MAX_UNACKED_BYTES)
    const nextBytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, type: 'event', id: ID, seq: events.length + 1, payload: chunk })
    ).byteLength
    expect(eventBytes + nextBytes).toBeGreaterThan(BRIDGE_MAX_UNACKED_BYTES)
    expect(bridge.last()).toEqual({ v: 1, type: 'end', id: ID, reason: 'overflow' })
  })

  it('reopens the byte window on ack, not just the frame window', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID, WINDOWED))
    const chunk = 'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES - 1024)
    bridge.client.streams[0]?.emit(chunk)
    const first = bridge.posted.find((json) => JSON.parse(json).type === 'event')
    expect(first).toBeDefined()
    if (first === undefined) {
      throw new Error('no event posted')
    }
    const frameBytes = new TextEncoder().encode(first).byteLength
    const fits = Math.floor(BRIDGE_MAX_UNACKED_BYTES / frameBytes)
    const events = (): BridgeHostMessage[] => bridge.frames().filter((f) => f.type === 'event')
    const emit = (times: number): void => {
      for (let index = 0; index < times; index += 1) {
        bridge.client.streams[0]?.emit(chunk)
      }
    }
    emit(fits - 1)
    expect(events()).toHaveLength(fits)
    bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: fits }))
    emit(fits)
    expect(frameBytes * fits * 2).toBeGreaterThan(BRIDGE_MAX_UNACKED_BYTES)
    // Keep the frame-count window open so only released acknowledgement bytes can unblock the batch.
    expect(fits * 2).toBeLessThan(BRIDGE_MAX_UNACKED_FRAMES)
    expect(events()).toHaveLength(fits * 2)
    expect(bridge.frames().some((frame) => frame.type === 'end')).toBe(false)
  })

  it('ends rather than posting an event the page would refuse as oversized', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID, WINDOWED))
    bridge.client.streams[0]?.emit('z'.repeat(BRIDGE_MAX_MESSAGE_BYTES))
    expect(bridge.last()).toEqual({ v: 1, type: 'end', id: ID, reason: 'overflow' })
  })

  it('keeps each stream on its own window', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID, WINDOWED))
    bridge.host.receive(subscribeFrame(OTHER, WINDOWED))
    for (let index = 0; index <= BRIDGE_MAX_UNACKED_FRAMES; index += 1) {
      bridge.client.streams[0]?.emit({ n: index })
    }
    bridge.client.streams[1]?.emit({ n: 0 })
    expect(bridge.last()).toEqual({ v: 1, type: 'event', id: OTHER, seq: 1, payload: { n: 0 } })
  })
})

describe('teardown', () => {
  it('rejects every pending as delivery-unknown, ends every stream, and refuses later frames', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(subscribeFrame(OTHER))
    bridge.host.dispose()
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([
      {
        v: 1,
        type: 'error',
        id: ID,
        error: {
          category: 'BridgeHostDisposedError',
          code: 'bridge_host_disposed',
          message: 'the page bridge was torn down before this request answered',
          isRpcDeliveryUnknown: true
        }
      },
      { v: 1, type: 'end', id: OTHER, reason: 'closed' }
    ])
    expect(bridge.client.streams[0]?.unsubscribes).toBe(1)
    bridge.client.requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    bridge.client.streams[0]?.emit({ chunk: 'a' })
    bridge.host.receive(clientFrame({ type: 'request', id: bridgeId(9), method: 'status.get' }))
    bridge.host.receive(subscribeFrame(bridgeId(10)))
    bridge.host.receive(clientFrame({ type: 'notify', name: 'foreground' }))
    bridge.host.receive(clientFrame({ type: 'ready' }))
    await flushBridge()
    expect(bridge.frames()).toHaveLength(3)
    expect(bridge.client.requests).toHaveLength(1)
    expect(bridge.client.streams).toHaveLength(1)
    expect(bridge.client.foregroundCalls).toEqual([])
    expect(bridge.diagnostics).toEqual(
      Array.from({ length: 4 }, () => ({ kind: 'frame-after-dispose' }))
    )
  })

  it('is idempotent', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(subscribeFrame(ID))
    bridge.host.dispose()
    bridge.host.dispose()
    expect(bridge.frames()).toHaveLength(2)
    expect(bridge.client.streams[0]?.unsubscribes).toBe(1)
  })

  it('settles what the page owned on close without answering a page that said goodbye', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(subscribeFrame(OTHER))
    bridge.host.receive(clientFrame({ type: 'close' }))
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([])
    expect(bridge.client.streams[0]?.unsubscribes).toBe(1)
    bridge.client.requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    bridge.client.streams[0]?.emit({ chunk: 'a' })
    await flushBridge()
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([])
  })

  it('answers the document that loads in after a close, rather than latching shut', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'close' }))
    // Document close must leave the host reusable; the next ready on this same view must receive full service.
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last().type).toBe('init')
    expect(bridge.client.stateListeners()).toBe(1)
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    expect(bridge.client.requests).toHaveLength(1)
    bridge.client.pushState('reconnecting')
    expect(bridge.last()).toMatchObject({ type: 'state', connection: { state: 'reconnecting' } })
    expect(bridge.diagnostics).toEqual([])
  })

  it('forwards no straggler from the document that said goodbye', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'close' }))
    // Refuse stragglers from the closed document rather than answering into its replacement.
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(subscribeFrame(OTHER))
    bridge.host.receive(clientFrame({ type: 'notify', name: 'foreground' }))
    expect(bridge.client.requests).toHaveLength(0)
    expect(bridge.client.streams).toHaveLength(0)
    expect(bridge.client.foregroundCalls).toEqual([])
    expect(bridge.posted).toHaveLength(0)
    expect(bridge.diagnostics).toEqual(
      Array.from({ length: 3 }, () => ({ kind: 'frame-after-close' }))
    )
  })

  it('posts nothing into a view that belongs to no document yet', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'close' }))
    // Client state fan-out continues between documents; do not post it into the replacement before init.
    bridge.client.pushState('reconnecting')
    bridge.client.pushState('connected')
    expect(bridge.posted).toHaveLength(0)
    expect(bridge.diagnostics).toEqual([])
  })
})
