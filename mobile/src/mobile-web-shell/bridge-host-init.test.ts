import { describe, expect, it } from 'vitest'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, HOST, PAGE_ROUTES, ROUTE } from './bridge-host-test-harness'
import {
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_ROUTE_PATHNAME_CHARS,
  BRIDGE_MAX_SUBSCRIPTIONS
} from './bridge/bridge-caps'
import { BRIDGE_FAULT_GRANT } from './bridge/bridge-envelope'

describe('init and state', () => {
  it('answers ready with the getters, the caps it enforces, and the grants it honours', () => {
    const client = createFakeRpcClient({
      getState: () => 'reconnecting',
      getReconnectAttempt: () => 3,
      getLastConnectedAt: () => 1_700_000_000_000,
      getLastInboundAt: () => 1_700_000_000_500,
      getGeneration: () => 7
    })
    const bridge = harness({ client })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.last()).toEqual({
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
      grants: {
        rpc: {
          maxPendingRequests: BRIDGE_MAX_PENDING_REQUESTS,
          maxSubscriptions: BRIDGE_MAX_SUBSCRIPTIONS
        },
        // What the shell will do for the page, and what makes its `navigate` frame acceptable.
        native: [
          BRIDGE_FAULT_GRANT,
          'navigate',
          'storage',
          'externalLink',
          'screencastBinary',
          'native.clipboard.write',
          'native.clipboard.read'
        ]
      },
      route: ROUTE,
      pageRoutes: PAGE_ROUTES,
      host: HOST,
      storage: {}
    })
  })

  it('names the screen the page is standing in for, which its own `/` cannot tell it', () => {
    const route = { pathname: '/h/host-a/session/wt-1', params: { name: 'a branch' } }
    const bridge = harness({ route })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.route).toEqual(route)
  })

  it('refuses to open a session at all for a route the protocol does not allow', () => {
    // The producer interpolates a host id into this pathname, so every one of these is reachable
    // from a deep link. Without the check the page refuses the whole `init`, asks again on its
    // backoff forever, and the shell un-hides a WebView that never paints.
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
    // Nothing is owed to the page for a notify, so nothing is posted back either.
    expect(bridge.frames().filter((frame) => frame.type === 'error')).toEqual([])
  })

  it('refuses a navigate frame that is not a path this app could open', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // The last three are shapes `replaceState` and the native push both normalise: `/h/../../etc/x`
    // resolves out of the `/h/` prefix entirely, and with no `+not-found` file expo-router's
    // Unmatched then paints over the shell. Whether the target names a screen that exists is not
    // something shape can answer; that check is C1.7's.
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
    // The whole app's preferences share one namespace, the hybrid shell flag included, so the
    // allowlist is what stands between a page and a feature it could turn on for itself.
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    for (const key of ['orca:mobileWebShellEnabled', 'orca:pins:', 'orca:hosts']) {
      bridge.host.receive(clientFrame({ type: 'notify', name: 'storage', key, value: 'x' }))
    }
    expect(bridge.storageWrites).toEqual([])
    expect(bridge.diagnostics).toEqual(
      Array.from({ length: 3 }, () => ({ kind: 'refused', refusal: 'unrecognised-message' }))
    )
  })

  it("refuses a write for another host's pinned list, which the envelope lets through", () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // `orca:pins:<any host>` is the right shape, so only the host knows this one is not the page's.
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'storage', key: 'orca:pins:other-host', value: '["x"]' })
    )
    expect(bridge.storageWrites).toEqual([])
    expect(bridge.diagnostics).toEqual([{ kind: 'storage-refused', key: 'orca:pins:other-host' }])
  })

  it('reads the keys again for each init, rather than replaying what it started with', () => {
    let pins = '["one"]'
    const bridge = harness({ readStorage: () => ({ 'orca:pins:host-a': pins }) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    pins = '["one","two"]'
    // The document that reloads inside one mount asks again, and has to be primed from after its
    // own writes rather than from the map the mount started with.
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const inits = bridge.frames().filter((frame) => frame.type === 'init')
    expect(inits.map((frame) => (frame.type === 'init' ? frame.storage : null))).toEqual([
      { 'orca:pins:host-a': '["one"]' },
      { 'orca:pins:host-a': '["one","two"]' }
    ])
  })

  it('hands the page what the app holds for the keys it may read', () => {
    const bridge = harness({ storage: { 'orca:pins:host-a': '["wt-1"]' } })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.storage).toEqual({ 'orca:pins:host-a': '["wt-1"]' })
    expect(init.type === 'init' && init.host).toEqual(HOST)
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

  it('re-answers ready, which is how a page that missed a state frame recovers', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.frames().filter((frame) => frame.type === 'init')).toHaveLength(2)
  })

  it('tells the shell the page spoke, on the first ask and on every re-ask', () => {
    const bridge = harness()
    expect(bridge.pageReadyCount()).toBe(0)
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(clientFrame({ type: 'ready' }))
    // The shell bounds the wait for the first of these; a page on its backoff must not have to
    // land a particular one to end it.
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
