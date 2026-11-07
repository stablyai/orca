import { describe, expect, it, vi } from 'vitest'
import { MobileEndpointNudgeRouter } from './mobile-endpoint-nudge-router'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

function routerFixture() {
  let foreground = false
  let localNetwork: string | null = null
  const logical = {
    getActivePath: vi.fn(() => 'relay'),
    getState: vi.fn(() => 'connected'),
    getGeneration: vi.fn(() => 1),
    sendRequest: vi.fn(async () => ({}))
  } as unknown as StableLogicalRpcClient
  const handleActiveNudge = vi.fn()
  const setForeground = vi.fn((next: boolean) => {
    foreground = next
  })
  const scheduleDirectProbe = vi.fn()
  const onLocalNetworkArrival = vi.fn()
  const router = new MobileEndpointNudgeRouter({
    logical,
    controller: { handleActiveNudge } as unknown as RelayReconnectController,
    isStopped: () => false,
    isForeground: () => foreground,
    setForeground,
    scheduleDirectProbe,
    readLocalNetwork: async () => localNetwork,
    onLocalNetworkArrival
  })
  const join = (network: string | null) => {
    localNetwork = network
  }
  return {
    handleActiveNudge,
    join,
    logical,
    onLocalNetworkArrival,
    router,
    scheduleDirectProbe,
    setForeground
  }
}

describe('MobileEndpointNudgeRouter', () => {
  it('processes a focus nudge after restoring lagging foreground state', () => {
    const fixture = routerFixture()

    fixture.router.nudge('focus')

    expect(fixture.setForeground).toHaveBeenCalledWith(true)
    expect(fixture.handleActiveNudge).toHaveBeenCalledWith(fixture.logical, 'focus')
    expect(fixture.logical.sendRequest).not.toHaveBeenCalled()
    expect(fixture.scheduleDirectProbe).toHaveBeenCalledOnce()
  })

  it('ignores a network nudge while backgrounded', () => {
    const fixture = routerFixture()

    fixture.router.nudge('network-change')

    expect(fixture.setForeground).not.toHaveBeenCalled()
    expect(fixture.handleActiveNudge).not.toHaveBeenCalled()
    expect(fixture.scheduleDirectProbe).not.toHaveBeenCalled()
  })
  it('counts only a move onto a new local network as an arrival', async () => {
    const fixture = routerFixture()
    fixture.router.nudge('focus')
    fixture.scheduleDirectProbe.mockClear()

    fixture.join('WIFI:192.168.1')
    fixture.router.nudge('network-change')
    await vi.waitFor(() => expect(fixture.onLocalNetworkArrival).toHaveBeenCalledOnce())
    fixture.router.nudge('network-change')
    fixture.router.nudge('app-resume')
    fixture.join(null)
    fixture.router.nudge('network-change')
    await vi.waitFor(() => expect(fixture.scheduleDirectProbe).toHaveBeenCalledTimes(2))
    fixture.join('WIFI:192.168.1')
    fixture.router.nudge('network-change')
    await vi.waitFor(() => expect(fixture.onLocalNetworkArrival).toHaveBeenCalledTimes(2))
    expect(fixture.handleActiveNudge).toHaveBeenCalledTimes(6)
  })
})
