import { describe, expect, it, vi } from 'vitest'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import type { RpcResponse } from './types'

function setup(waitForConnected: () => Promise<void> = async () => {}) {
  let sequence = 0
  const sendFrame = vi.fn(() => true)
  const streams = new MobileRelayRpcStreams({
    nextId: () => `request-${++sequence}`,
    sendFrame,
    waitForConnected
  })
  const ready = (): RpcResponse => ({
    id: 'request-1',
    ok: true,
    streaming: true,
    result: { type: 'ready', subscriptionId: 'server-subscription' },
    _meta: { runtimeId: 'runtime' }
  })
  return { streams, sendFrame, ready }
}

// mobile-relay-rpc-stream-cancellation.test.ts owns the screencast, client-events, terminal,
// session-tabs and native-chat routes; this file covers the two remaining server subscriptions.
describe('relay server subscription cleanup', () => {
  it.each([
    ['files.watch', 'files.unwatch'],
    ['accounts.subscribe', 'accounts.unsubscribe']
  ])('releases %s before and after the ready response', async (method, unsubscribeMethod) => {
    for (const cancelBeforeReady of [false, true]) {
      const { streams, sendFrame, ready } = setup()
      const listener = vi.fn()
      const cancel = streams.subscribe(method, {}, listener)
      await Promise.resolve()
      if (cancelBeforeReady) {
        cancel()
      }
      expect(streams.handleResponse(ready())).toBe(true)
      cancel()
      cancel()
      expect(sendFrame.mock.calls).toEqual([
        [{ id: 'request-1', method, params: {} }],
        [
          {
            id: 'request-2',
            method: unsubscribeMethod,
            params: { subscriptionId: 'server-subscription' }
          }
        ]
      ])
      expect(listener).toHaveBeenCalledTimes(cancelBeforeReady ? 0 : 1)
      expect(streams.handleResponse(ready())).toBe(false)
    }
  })

  it('never sends a subscription cancelled before connection', async () => {
    const connection = Promise.withResolvers<void>()
    const { streams, sendFrame, ready } = setup(() => connection.promise)
    const listener = vi.fn()
    streams.subscribe('files.watch', {}, listener)()
    connection.resolve()
    await Promise.resolve()
    expect(sendFrame).not.toHaveBeenCalled()
    expect(streams.handleResponse(ready())).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('discards a cancelled subscription when the host rejects it', async () => {
    const { streams, sendFrame } = setup()
    const listener = vi.fn()
    const cancel = streams.subscribe('files.watch', {}, listener)
    await Promise.resolve()
    cancel()
    const failure: RpcResponse = {
      id: 'request-1',
      ok: false,
      error: { code: 'unsupported', message: 'unsupported' },
      _meta: { runtimeId: 'runtime' }
    }
    expect(streams.handleResponse(failure)).toBe(true)
    expect(streams.handleResponse(failure)).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    expect(sendFrame).toHaveBeenCalledOnce()
  })
})
