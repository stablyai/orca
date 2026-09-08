import { describe, expect, it, vi } from 'vitest'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'

function fixture() {
  let next = 0
  const send = vi.fn(() => true)
  const registry = new RpcClientStreamRegistry({
    nextId: () => String(++next),
    deviceToken: 'token',
    getState: () => 'connected',
    sendEncrypted: send
  })
  const snapshot = (id = '1') =>
    registry.handleResponse({
      id,
      ok: true,
      streaming: true,
      result: { type: 'snapshot', worktree: 'wt-1', tabs: [] },
      _meta: { runtimeId: 'host' }
    })
  return { registry, send, snapshot }
}

describe('direct session tab subscription cleanup', () => {
  it.each([true, false])('isolates cancellation from a sibling, before snapshot=%s', (early) => {
    const { registry, send, snapshot } = fixture()
    const listener = vi.fn()
    const stop = registry.subscribe('session.tabs.subscribe', { worktree: 'id:wt-1' }, listener)
    const sibling = vi.fn()
    registry.subscribe('session.tabs.subscribe', { worktree: 'id:wt-1' }, sibling)
    if (early) {
      stop()
      expect(send).toHaveBeenCalledTimes(2)
    }
    snapshot()
    stop()
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'session.tabs.unsubscribe',
        params: { worktree: 'id:wt-1', subscriptionId: '1' }
      })
    )
    expect(registry.size()).toBe(1)
    expect(listener).toHaveBeenCalledTimes(early ? 0 : 1)
    snapshot('2')
    expect(sibling).toHaveBeenCalledOnce()
  })

  it('waits for the new registration after reconnecting', () => {
    const { registry, send, snapshot } = fixture()
    const stop = registry.subscribe('session.tabs.subscribe', { worktree: 'id:wt-1' }, () => {})
    snapshot()
    registry.markForReplay()
    registry.replayAfterAuthentication()
    stop()
    expect(send).toHaveBeenCalledTimes(2)
    snapshot()
    expect(send).toHaveBeenCalledTimes(3)
    expect(registry.size()).toBe(0)
  })
})
