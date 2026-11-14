import { describe, expect, it } from 'vitest'

import { harness, ID, OTHER, subscribeFrame } from '../test-support/bridge-host-test-harness'
import { BRIDGE_MAX_UNACKED_FRAMES } from '../host-streams/bridge-host-subscriptions'
import {
  clientFrame,
  createFakeRpcClient,
  flushBridge,
  rpcSuccess
} from '../test-support/bridge-host-test-fakes'

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

  it('stops answering a cancelled request without pretending the desktop stopped running it', async () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'request' }))
    bridge.client.requests[0]?.resolve(rpcSuccess('wire-1', 'ok'))
    await flushBridge()
    expect(bridge.frames().filter((frame) => frame.type !== 'init')).toEqual([])
  })
})

describe('backpressure', () => {
  // Use a nonterminal stream to test the byte window; terminal.subscribe now holds/coalesces output and tests that exception separately.
  const WINDOWED = 'session.tabs.subscribe'

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
