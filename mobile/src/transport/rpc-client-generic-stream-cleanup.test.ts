import { describe, expect, it, vi } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'

function fixture() {
  let next = 0
  const send = vi.fn().mockReturnValue(true)
  const registry = new RpcClientStreamRegistry({
    nextId: () => String(++next),
    deviceToken: 'private-token',
    getState: () => 'connected',
    sendEncrypted: send
  })
  const ready = (subscriptionId: string) =>
    registry.handleResponse({
      id: '1',
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId },
      _meta: { runtimeId: 'host' }
    })
  return { registry, send, ready }
}

describe('Desktop-advertised stream cleanup', () => {
  it.each([true, false])(
    'cleans up an arbitrary method when cancellation precedes ready: %s',
    (early) => {
      const { registry, send, ready } = fixture()
      const listener = vi.fn()
      const stop = registry.subscribe('future.watch', {}, listener, {
        serverUnsubscribeMethod: 'future.release'
      })
      if (early) {
        stop()
      }
      ready('opaque-lease')
      if (!early) {
        stop()
      }
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: 'future.release',
          params: { subscriptionId: 'opaque-lease' }
        })
      )
      expect(registry.size()).toBe(0)
      if (early) {
        expect(listener).not.toHaveBeenCalled()
      }
    }
  )

  it('does not cancel an old lease while a reconnect is awaiting its new ready frame', () => {
    const { registry, send, ready } = fixture()
    const stop = registry.subscribe('future.watch', {}, () => {}, {
      serverUnsubscribeMethod: 'future.release'
    })
    ready('old')
    registry.markForReplay()
    registry.replayAfterAuthentication()
    stop()
    expect(send.mock.calls.filter(([request]) => request.method === 'future.release')).toHaveLength(
      0
    )
    ready('new')
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { subscriptionId: 'new' } })
    )
  })

  it.each([true, false])(
    'removes ended streams before reconnect replay: streaming=%s',
    (streaming) => {
      const { registry, send, ready } = fixture()
      const listener = vi.fn()
      registry.subscribe('future.watch', {}, listener, {
        serverUnsubscribeMethod: 'future.release'
      })
      ready('lease')
      registry.handleResponse({
        id: '1',
        ok: true,
        streaming,
        result: { type: 'end' },
        _meta: { runtimeId: 'host' }
      })
      expect(listener).toHaveBeenLastCalledWith({ type: 'end' })
      expect(registry.size()).toBe(0)
      registry.markForReplay()
      registry.replayAfterAuthentication()
      expect(send).toHaveBeenCalledOnce()
    }
  )
})
