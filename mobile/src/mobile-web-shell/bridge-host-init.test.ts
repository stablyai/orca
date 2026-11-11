import { describe, expect, it } from 'vitest'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, ROUTE } from './bridge-host-test-harness'
import { routeViewOf } from './page-route-policy'

describe('init and state', () => {
  // Drive manifest projection through routeViewOf: newer desktop fields must be stripped before strict pair parsing, or the whole init is refused.
  it('answers init for a route entry carrying a manifest field this build does not read', () => {
    const declared = [
      {
        pathname: '/h/[hostId]',
        grants: ['navigate', 'storage', 'haptics'],
        renderer: 'someLaterDesktopsField'
      }
    ]
    const bridge = harness({
      pageRouteGrants: routeViewOf(declared, ROUTE.pathname).pageRouteGrants
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.routeRefusals).toEqual([])
    const init = bridge.last()
    if (init.type !== 'init') {
      throw new Error('expected an init frame')
    }
    expect(init.pageRouteGrants).toEqual([
      { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'haptics'] }
    ])
  })
  // Advance the held route even when posting fails; the next document’s ready must repair delivery with the newest tap (ruling 34 addendum).
  it('answers the next document with the route a tap wrote while the view was gone', async () => {
    const view = { gone: true }
    const bridge = harness({
      route: { pathname: '/h/host-a/session/wt-1' },
      post: () => (view.gone ? Promise.reject(new Error('the view is gone')) : Promise.resolve())
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.publishRoute({
      pathname: '/h/host-a/session/wt-1',
      params: { paneKey: 'pane-1' }
    })
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve()
    }
    expect(bridge.posted).toHaveLength(2)
    view.gone = false
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.route).toEqual({
      pathname: '/h/host-a/session/wt-1',
      params: { paneKey: 'pane-1' }
    })
  })
  it('reads the keys again for each init, rather than replaying what it started with', () => {
    let pins = '["one"]'
    const bridge = harness({
      readStorage: () => ({ storage: { 'orca:pins:host-a': pins }, storageOversize: [] })
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    pins = '["one","two"]'
    // Reloaded documents must see writes made since mount in their new init.
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const inits = bridge.frames().filter((frame) => frame.type === 'init')
    expect(inits.map((frame) => (frame.type === 'init' ? frame.storage : null))).toEqual([
      { 'orca:pins:host-a': '["one"]' },
      { 'orca:pins:host-a': '["one","two"]' }
    ])
  })

  it('pushes the event state, not the getter a listener can outrun', () => {
    const bridge = harness()
    bridge.client.pushState('disconnected')
    const pushed = bridge.last()
    expect(pushed.type === 'state' && pushed.connection.state).toBe('disconnected')
  })

  it('sends a page that reads them a path frame when a relay dial starts without a state change', () => {
    let pendingPath: 'relay' | null = null
    let notifyPath = () => {}
    const client = createFakeRpcClient({
      getState: () => 'reconnecting',
      getActivePath: () => 'lan',
      getPendingPath: () => pendingPath,
      getRelayHostReachability: () => 'host-offline',
      onConnectionPathChange: (listener) => {
        notifyPath = listener
        return () => {}
      }
    })
    const bridge = harness({ client })
    bridge.host.receive(clientFrame({ type: 'ready', connectionPathFrames: true }))

    pendingPath = 'relay'
    notifyPath()
    const pushed = bridge.last()
    expect(pushed.type === 'connectionPath' && pushed.connection).toMatchObject({
      state: 'reconnecting',
      activePath: 'lan',
      pendingPath: 'relay',
      relayHostReachability: 'host-offline'
    })
  })
})
