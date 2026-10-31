import { describe, expect, it } from 'vitest'
import { harness } from '../bridge-host-test-harness'
import { bridgeId, clientFrame, flushBridge, rpcSuccess } from '../bridge-host-test-fakes'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge-caps'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { createPageClient, INIT, idOf } from './bridge-page-client-test-harness'

const FORWARDED_LIMIT = BRIDGE_MAX_PENDING_REQUESTS - 4

describe('native request capacity under desktop congestion', () => {
  it('reserves local slots on the page while retaining the total cap', async () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...INIT.grants, native: ['native.media.pick'] } })
    const held = Array.from({ length: FORWARDED_LIMIT }, () =>
      page.client.sendRequest('worktree.ps').catch(() => undefined)
    )
    await expect(page.client.sendRequest('worktree.ps')).rejects.toThrow(/requests/)
    for (let index = 0; index < 4; index += 1) {
      held.push(
        page.client
          .callNativeVerb('native.media.pick', { source: 'library', multiple: true })
          .catch(() => undefined)
      )
    }
    expect(page.frames().filter((frame) => frame.type === 'request')).toHaveLength(64)
    await expect(
      page.client.callNativeVerb('native.media.pick', { source: 'library', multiple: true })
    ).rejects.toThrow(/requests/)
    page.deliver({
      v: 1,
      type: 'reply',
      id: idOf(page, FORWARDED_LIMIT),
      payload: {
        id: 'native',
        ok: true,
        result: { items: [] },
        _meta: { runtimeId: 'native-shell' }
      }
    })
    held.push(
      page.client
        .callNativeVerb('native.media.pick', { source: 'library', multiple: true })
        .catch(() => undefined)
    )
    expect(page.frames().filter((frame) => frame.type === 'request')).toHaveLength(65)
    page.client.close()
    await Promise.all(held)
  })

  it('completes a real native round trip while desktop calls remain unanswered', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const held = Array.from({ length: FORWARDED_LIMIT }, () =>
      pair.client.sendRequest('worktree.ps').catch(() => undefined)
    )
    const pick = pair.client.callNativeVerb('native.media.pick', {
      source: 'library',
      multiple: true
    })
    await pair.flush()
    expect((await pick).result).toEqual({ items: [] })
    expect(pair.rpc.requests).toHaveLength(FORWARDED_LIMIT)
    pair.client.close()
    pair.host.dispose()
    await Promise.all(held)
  })

  it('protects native capacity from an older page that forwards past the reservation', async () => {
    const bridge = harness({ ready: true, serveNativeVerb: async () => ({ items: [] }) })
    for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      bridge.host.receive(
        clientFrame({ type: 'request', id: bridgeId(index), method: 'worktree.ps' })
      )
    }
    expect(bridge.client.requests).toHaveLength(FORWARDED_LIMIT)
    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: bridgeId(100),
        method: 'native.media.pick',
        params: { source: 'library', multiple: true }
      })
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.frames()).toContainEqual(
      expect.objectContaining({ type: 'reply', id: bridgeId(100) })
    )
  })
})

it.each(['cancel', 'close'] as const)(
  'retains the host mixed total cap through %s until actual settlement',
  async (teardown) => {
    const native = Promise.withResolvers<unknown>()
    const bridge = harness({ ready: true, serveNativeVerb: () => native.promise })
    for (let index = 0; index < FORWARDED_LIMIT; index += 1) {
      bridge.host.receive(
        clientFrame({ type: 'request', id: bridgeId(index), method: 'worktree.ps' })
      )
    }
    const openNative = (index: number): void =>
      bridge.host.receive(
        clientFrame({
          type: 'request',
          id: bridgeId(index),
          method: 'native.media.pick',
          params: { source: 'library', multiple: true }
        })
      )
    for (let index = FORWARDED_LIMIT; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      openNative(index)
    }
    expect(bridge.nativeCalls).toHaveLength(4)
    openNative(100)
    expect(bridge.last()).toMatchObject({
      type: 'error',
      id: bridgeId(100),
      error: { code: 'bridge_cap_exceeded' }
    })
    if (teardown === 'close') {
      bridge.host.receive(clientFrame({ type: 'close' }))
      bridge.host.receive(clientFrame({ type: 'ready' }))
    } else {
      for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
        bridge.host.receive(clientFrame({ type: 'cancel', id: bridgeId(index), target: 'request' }))
      }
    }
    openNative(101)
    expect(bridge.last()).toMatchObject({
      type: 'error',
      id: bridgeId(101),
      error: { code: 'bridge_cap_exceeded' }
    })
    expect(bridge.nativeCalls).toHaveLength(4)
    bridge.client.requests[0]?.resolve(rpcSuccess('wire', 'settled'))
    await flushBridge()
    openNative(102)
    expect(bridge.nativeCalls).toHaveLength(5)
    native.resolve({ items: [] })
    for (const request of bridge.client.requests) {
      request.resolve(rpcSuccess('wire', 'settled'))
    }
    await flushBridge()
  }
)
