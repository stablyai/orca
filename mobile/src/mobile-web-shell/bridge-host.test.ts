import { describe, expect, it } from 'vitest'

import { harness, ID, OTHER, subscribeFrame, type Harness } from './bridge-host-test-harness'
import { BRIDGE_MAX_UNACKED_FRAMES } from './bridge-host-subscriptions'
import { clientFrame, createFakeRpcClient, flushBridge, rpcSuccess } from './bridge-host-test-fakes'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge/bridge-caps'

describe('requests', () => {
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

  it('stops answering a cancelled request without pretending the desktop stopped running it', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'request' }))
    bridge.client.requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([])
  })
})

describe('subscriptions', () => {
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
