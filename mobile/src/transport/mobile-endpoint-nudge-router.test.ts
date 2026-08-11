import { describe, expect, it, vi } from 'vitest'
import { MobileEndpointNudgeRouter } from './mobile-endpoint-nudge-router'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

function routerFixture() {
  let foreground = false
  const logical = {
    getActivePath: vi.fn(() => 'relay'),
    getState: vi.fn(() => 'connected'),
    getGeneration: vi.fn(() => 1),
    sendRequest: vi.fn(async () => ({}))
  } as unknown as StableLogicalRpcClient
  const handleActiveNudge = vi.fn(() => 'probe' as const)
  const setForeground = vi.fn((next: boolean) => {
    foreground = next
  })
  const scheduleDirectProbe = vi.fn()
  const router = new MobileEndpointNudgeRouter({
    logical,
    controller: { handleActiveNudge } as unknown as RelayReconnectController,
    now: () => 20_000,
    isStopped: () => false,
    isForeground: () => foreground,
    setForeground,
    replaceRelay: vi.fn(),
    recoverAfterDeadProbe: vi.fn(),
    scheduleDirectProbe
  })
  return { handleActiveNudge, logical, router, scheduleDirectProbe, setForeground }
}

describe('MobileEndpointNudgeRouter', () => {
  it('processes a focus nudge after restoring lagging foreground state', () => {
    const fixture = routerFixture()

    fixture.router.nudge('focus')

    expect(fixture.setForeground).toHaveBeenCalledWith(true)
    expect(fixture.handleActiveNudge).toHaveBeenCalledWith(fixture.logical, 'focus')
    expect(fixture.logical.sendRequest).toHaveBeenCalledWith('status.get', null, {
      timeoutMs: 4000
    })
    expect(fixture.scheduleDirectProbe).toHaveBeenCalledOnce()
  })

  it('ignores a network nudge while backgrounded', () => {
    const fixture = routerFixture()

    fixture.router.nudge('network-change')

    expect(fixture.setForeground).not.toHaveBeenCalled()
    expect(fixture.handleActiveNudge).not.toHaveBeenCalled()
    expect(fixture.scheduleDirectProbe).not.toHaveBeenCalled()
  })
})
