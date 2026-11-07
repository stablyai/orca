import { describe, expect, it } from 'vitest'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, ROUTE } from './bridge-host-test-harness'
import { BRIDGE_MAX_ROUTE_PATHNAME_CHARS } from './bridge/bridge-caps'
import { BRIDGE_FAULT_GRANT, BRIDGE_RPC_ENVELOPE_GRANT } from './bridge/bridge-envelope'
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

  // Compare both lists from one init: the opener’s manifest pair must equal grants.native minus the protocol grant, including optional grants.
  it("grants a session exactly what it publishes as that pattern's pair", () => {
    const declared = [
      {
        pathname: '/h/[hostId]',
        grants: ['navigate', 'storage', 'haptics'],
        optionalGrants: ['screencastBinary']
      }
    ]
    const view = routeViewOf(declared, ROUTE.pathname)
    const bridge = harness({ routeGrants: view.routeGrants, pageRouteGrants: view.pageRouteGrants })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    if (init.type !== 'init') {
      throw new Error('expected an init frame')
    }
    expect(init.grants.native).toEqual([
      BRIDGE_FAULT_GRANT,
      BRIDGE_RPC_ENVELOPE_GRANT,
      'navigate',
      'storage',
      'haptics',
      'screencastBinary'
    ])
    const pair = (init.pageRouteGrants ?? []).find((entry) => entry.pathname === '/h/[hostId]')
    expect(pair?.grants).toEqual(['navigate', 'storage', 'haptics', 'screencastBinary'])
    expect(init.grants.native).toContain('screencastBinary')
  })

  it('refuses to open a session at all for a route the protocol does not allow', () => {
    // Deep-link host ids reach the producer’s interpolation; refusing them here avoids an init loop behind a blank WebView.
    for (const pathname of [
      '/h/a?b',
      '/h/a#b',
      '/h/a b',
      '/h/..',
      '/../../etc',
      '/h/a\\b',
      '//evil',
      `/h/${'a'.repeat(BRIDGE_MAX_ROUTE_PATHNAME_CHARS)}`
    ]) {
      const bridge = harness({ route: { pathname } })
      bridge.host.receive(clientFrame({ type: 'ready' }))
      expect(bridge.posted, pathname).toEqual([])
      expect(bridge.routeRefusals, pathname).toHaveLength(1)
      expect(
        bridge.diagnostics.map((diagnostic) => diagnostic.kind),
        pathname
      ).toEqual(['route-refused'])
    }
  })

  it('reports a frame the view would not take, and waits for the next ask (ruling 34)', async () => {
    const bridge = harness({
      route: { pathname: '/h/host-a' },
      post: () => Promise.reject(new Error('the view is gone'))
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve()
    }
    expect(bridge.diagnostics.map((diagnostic) => diagnostic.kind)).toContain('post-failed')
    // Do not hold/retry the failed post; answer the page’s next ready with the current route.
    expect(bridge.posted).toHaveLength(1)
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.posted).toHaveLength(2)
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

  it('refuses a navigate frame that is not a path this app could open', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // WHATWG normalization can move dot segments outside /h/; reject those shapes before Expo’s Unmatched replaces the shell. Screen existence is checked separately.
    const refused = [
      '//evil.example/h',
      'h/host-a',
      'https://evil.example',
      '/h#top',
      '/h/../../etc/x',
      '/h/host-a/./tasks',
      '/h/a\\b'
    ]
    for (const href of refused) {
      bridge.host.receive(clientFrame({ type: 'notify', name: 'navigate', href }))
    }
    expect(bridge.navigations).toEqual([])
    expect(bridge.diagnostics).toEqual(
      refused.map(() => ({ kind: 'refused', refusal: 'unrecognised-message' }))
    )
  })

  it('serves no navigate to a page that has said goodbye', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'close' }))
    bridge.host.receive(clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-a/tasks' }))
    expect(bridge.navigations).toEqual([])
  })

  it('refuses a storage write for a key the page was never told about', () => {
    // Preferences share a namespace across paired hosts; the allowlist protects native-owned state.
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    for (const key of ['orca:pins:', 'orca:hosts']) {
      bridge.host.receive(clientFrame({ type: 'notify', name: 'storage', key, value: 'x' }))
    }
    expect(bridge.storageWrites).toEqual([])
    expect(bridge.diagnostics).toEqual(
      Array.from({ length: 2 }, () => ({ kind: 'refused', refusal: 'unrecognised-message' }))
    )
  })

  it("refuses a write for another host's pinned list, which the envelope lets through", () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // The key shape is valid; only session scope identifies another host’s pinned list.
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'storage', key: 'orca:pins:other-host', value: '["x"]' })
    )
    expect(bridge.storageWrites).toEqual([])
    expect(bridge.diagnostics).toEqual([{ kind: 'storage-refused', key: 'orca:pins:other-host' }])
  })

  // Enforce oversized-key refusal in the shell too; older pages ignore storageOversize and could overwrite device state (ruling 33.6).
  it('refuses a write for a key it could not hand the page, whatever the page believes', () => {
    const journal = 'orca:mobileStructuredSendOperations:v1'
    const bridge = harness({
      readStorage: () => ({
        storage: { 'orca:pins:host-a': '["one"]' },
        storageOversize: [journal]
      })
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'storage', key: journal, value: '{"v":1,"entries":[]}' })
    )
    expect(bridge.storageWrites).toEqual([])
    expect(bridge.diagnostics).toEqual([{ kind: 'storage-refused', key: journal }])
    // A handed-over key remains writable, proving refusal depends on size rather than key shape.
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'storage', key: 'orca:pins:host-a', value: '["two"]' })
    )
    expect(bridge.storageWrites).toEqual([{ key: 'orca:pins:host-a', value: '["two"]' }])
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

  it('preserves pending and connected Iroh paths through the page frame reader', () => {
    let activePath: 'lan' | 'iroh' = 'lan'
    let pendingPath: 'iroh' | null = 'iroh'
    let notifyPath = () => {}
    const client = createFakeRpcClient({
      getActivePath: () => activePath,
      getPendingPath: () => pendingPath,
      onConnectionPathChange: (listener) => {
        notifyPath = listener
        return () => {}
      }
    })
    const bridge = harness({ client })
    bridge.host.receive(clientFrame({ type: 'ready', connectionPathFrames: true }))
    const init = bridge.last()
    expect(init.type === 'init' && init.connection).toMatchObject({
      activePath: 'lan',
      pendingPath: 'iroh'
    })

    activePath = 'iroh'
    pendingPath = null
    notifyPath()

    const pushed = bridge.last()
    expect(pushed.type === 'connectionPath' && pushed.connection).toMatchObject({
      activePath: 'iroh',
      pendingPath: null
    })
  })

  it('sends no path frame to a page that never said it reads them', () => {
    let notifyPath = () => {}
    const client = createFakeRpcClient({
      onConnectionPathChange: (listener) => {
        notifyPath = listener
        return () => {}
      }
    })
    const bridge = harness({ client })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const sent = bridge.frames().length

    notifyPath()

    expect(bridge.frames()).toHaveLength(sent)
  })

  it('drops the state listener on dispose', () => {
    const bridge = harness()
    expect(bridge.client.stateListeners()).toBe(1)
    bridge.host.dispose()
    expect(bridge.client.stateListeners()).toBe(0)
  })
})
