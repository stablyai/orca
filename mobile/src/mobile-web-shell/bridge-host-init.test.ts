import { describe, expect, it } from 'vitest'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, HOST, PAGE_ROUTE_GRANTS, PAGE_ROUTES, ROUTE } from './bridge-host-test-harness'
import { BRIDGE_MAX_ROUTE_PATHNAME_CHARS } from './bridge/bridge-caps'
import { BRIDGE_FAULT_GRANT, BRIDGE_RPC_ENVELOPE_GRANT } from './bridge/bridge-envelope'
import { routeViewOf } from './page-route-policy'

describe('init and state', () => {
  it('answers ready with the connection getters and session snapshot', () => {
    const client = createFakeRpcClient({
      getState: () => 'reconnecting',
      getReconnectAttempt: () => 3,
      getLastConnectedAt: () => 1_700_000_000_000,
      getLastInboundAt: () => 1_700_000_000_500,
      getGeneration: () => 7
    })
    const bridge = harness({ client, storage: { 'orca:pins:host-a': '["wt-1"]' } })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last()).toMatchObject({
      v: 1,
      type: 'init',
      sessionId: 'session-a',
      buildId: 'build-a',
      connection: {
        state: 'reconnecting',
        reconnectAttempt: 3,
        lastConnectedAt: 1_700_000_000_000,
        lastInboundAt: 1_700_000_000_500,
        generation: 7
      },
      route: ROUTE,
      pageRoutes: PAGE_ROUTES,
      pageRouteGrants: PAGE_ROUTE_GRANTS,
      host: HOST,
      storage: { 'orca:pins:host-a': '["wt-1"]' }
    })
  })

  // Route patterns alone cannot authorize local hops; init must carry manifest grant pairs so a target cannot run without capabilities such as clipboard.write.
  it('carries what every page route declared, not only which patterns exist', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type).toBe('init')
    if (init.type !== 'init') {
      throw new Error('expected an init frame')
    }
    expect((init.pageRouteGrants ?? []).map((entry) => entry.pathname)).toEqual([...PAGE_ROUTES])
    expect(init.pageRouteGrants).toEqual(PAGE_ROUTE_GRANTS)
  })

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

  it('refuses a grant name the manifest grammar refuses, naming the field it came from', () => {
    // Reject names the manifest grammar cannot declare.
    const bridge = harness({
      pageRouteGrants: [{ pathname: '/h/[hostId]', grants: ['native.clipboard'] }]
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.posted.length).toBe(0)
    expect(bridge.routeRefusals).toHaveLength(1)
    const [reason] = bridge.routeRefusals
    // Name the refused field so a valid pathname cannot be mistaken for the cause.
    expect(reason.startsWith('pageRouteGrants: ')).toBe(true)
    expect(reason.slice('pageRouteGrants: '.length)).not.toBe('')
    expect(bridge.diagnostics).toEqual([{ kind: 'route-refused', issue: reason }])
  })

  it('blames the route, not the pairs, when the route is the malformed one', () => {
    // Use a pathname refusal as the control so an unconditional prefix cannot satisfy both cases.
    const bridge = harness({ route: { pathname: '/h/a?b' } })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.routeRefusals).toHaveLength(1)
    const [reason] = bridge.routeRefusals
    expect(reason.startsWith('pageRouteGrants: ')).toBe(false)
    expect(reason).not.toBe('')
  })

  it('names the screen the page is standing in for, which its own `/` cannot tell it', () => {
    const route = { pathname: '/h/host-a/session/wt-1', params: { name: 'a branch' } }
    const bridge = harness({ route })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.route).toEqual(route)
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

  it('answers a ready for a refused route with nothing at all', async () => {
    // Report ready even when the route cannot produce init; the session switch normally prevents this state before shell mount.
    const bridge = harness({ route: { pathname: '/h/a b' } })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    await Promise.resolve()
    expect(bridge.posted).toEqual([])
    expect(bridge.pageReadyCount()).toBe(1)
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

  it('opens a session for the routes a screen actually produces', () => {
    for (const pathname of ['/h/host-a', '/h/host-a/tasks', '/h/a%20b', '/']) {
      const bridge = harness({ route: { pathname } })
      bridge.host.receive(clientFrame({ type: 'ready' }))
      expect(bridge.last().type, pathname).toBe('init')
      expect(bridge.routeRefusals, pathname).toEqual([])
    }
  })

  it('opens the screen a page asks for, without routing it to the client', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-a/session/wt-1?name=a+b' })
    )
    expect(bridge.navigations).toEqual(['/h/host-a/session/wt-1?name=a+b'])
    expect(bridge.client.requests).toEqual([])
    expect(bridge.frames().filter((frame) => frame.type === 'error')).toEqual([])
  })

  it('tells the screen whether the page asked to replace it', () => {
    const opened: [string, boolean][] = []
    const bridge = harness({ onNavigate: (href, replace) => opened.push([href, replace]) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-a/tasks' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-a/tasks', replace: true })
    )
    expect(opened).toEqual([
      ['/h/host-a/tasks', false],
      ['/h/host-a/tasks', true]
    ])
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

  it('opens a target whose segments merely contain dots, which the refusals above must not', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-a/a..b?q=.' })
    )
    expect(bridge.navigations).toEqual(['/h/host-a/a..b?q=.'])
  })

  it('serves no navigate to a page that has said goodbye', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'close' }))
    bridge.host.receive(clientFrame({ type: 'notify', name: 'navigate', href: '/h/host-a/tasks' }))
    expect(bridge.navigations).toEqual([])
  })

  it('writes an allowlisted key into the app store, without routing it to the client', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'storage', key: 'orca:pins:host-a', value: '["wt-1"]' })
    )
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'storage', key: 'orca:pins:host-a', value: null })
    )
    expect(bridge.storageWrites).toEqual([
      { key: 'orca:pins:host-a', value: '["wt-1"]' },
      { key: 'orca:pins:host-a', value: null }
    ])
    expect(bridge.client.requests).toEqual([])
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

  it('reports a client without the optional getters as null rather than omitting the field', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.connection).toEqual({
      state: 'connected',
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastInboundAt: null,
      generation: null
    })
  })

  it('tells the shell the page spoke, on the first ask and on every re-ask', () => {
    const bridge = harness()
    expect(bridge.pageReadyCount()).toBe(0)
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // Every ready ends the startup wait; a page’s backoff need not hit a particular ask.
    expect(bridge.pageReadyCount()).toBe(2)
  })

  it('says nothing about a page that never asked, however much else it posts', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'notify', name: 'foreground' }))
    expect(bridge.pageReadyCount()).toBe(0)
  })

  it('pushes the event state, not the getter a listener can outrun', () => {
    const bridge = harness()
    bridge.client.pushState('disconnected')
    const pushed = bridge.last()
    expect(pushed.type === 'state' && pushed.connection.state).toBe('disconnected')
  })

  it('drops the state listener on dispose', () => {
    const bridge = harness()
    expect(bridge.client.stateListeners()).toBe(1)
    bridge.host.dispose()
    expect(bridge.client.stateListeners()).toBe(0)
  })
})
