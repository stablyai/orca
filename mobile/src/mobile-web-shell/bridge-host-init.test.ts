import { describe, expect, it } from 'vitest'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness } from './bridge-host-test-harness'

describe('init and state', () => {
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
