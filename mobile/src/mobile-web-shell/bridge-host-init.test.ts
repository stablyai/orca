import { describe, expect, it } from 'vitest'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, HOST, PAGE_ROUTE_GRANTS, PAGE_ROUTES, ROUTE } from './bridge-host-test-harness'
import {
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_ROUTE_PATHNAME_CHARS,
  BRIDGE_MAX_SUBSCRIPTIONS
} from './bridge/bridge-caps'
import { BRIDGE_FAULT_GRANT } from './bridge/bridge-envelope'
import { BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT } from './bridge/bridge-page-client-identity'
import { BRIDGE_ROUTE_PARAM_CLEAR } from './bridge/bridge-route-update'
import { routeViewOf } from './page-route-policy'

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
      // What this shell takes from the page, which is the page's own check before it posts one.
      accepts: [BRIDGE_ROUTE_PARAM_CLEAR, BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT],
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
          'haptics',
          'externalNavigation',
          'native.clipboard.write',
          'native.clipboard.read',
          'native.media.pick',
          'native.media.read',
          'native.media.release',
          'native.audio.start',
          'native.audio.read',
          'native.audio.stop'
        ]
      },
      route: ROUTE,
      pageRoutes: PAGE_ROUTES,
      pageRouteGrants: PAGE_ROUTE_GRANTS,
      host: HOST,
      storage: {}
    })
  })

  /**
   * The page cannot decide an in-page hop without knowing what the target needs.
   *
   * `pageRoutes` says which patterns this shell would render; it does not say what each one
   * declared. A page that keeps a push local on the strength of the pattern alone runs the target
   * under the opener's grants, which is how the tasks page reached the sidebar without
   * `native.clipboard.write`. So `init` carries the manifest's own pairs.
   */
  it('carries what every page route declared, not only which patterns exist', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type).toBe('init')
    if (init.type !== 'init') {
      throw new Error('expected an init frame')
    }
    // Every pattern the page is told it may keep has an entry saying what keeping it costs.
    expect((init.pageRouteGrants ?? []).map((entry) => entry.pathname)).toEqual([...PAGE_ROUTES])
    expect(init.pageRouteGrants).toEqual(PAGE_ROUTE_GRANTS)
  })

  /**
   * The publish path end to end, because each half of it looks correct alone.
   *
   * The phone reads a manifest route loosely and this schema is `.strict()`, so an entry carrying a
   * field a newer desktop wrote refuses the pairs -- and the refusal is not the field being dropped,
   * it is `createBridgeHost` refusing the route and the page never getting an `init` at all. Driven
   * through `routeViewOf` rather than by handing the harness a pair, because the publish is the
   * thing under test and a hand-built pair proves nothing about it.
   */
  it('answers init for a route entry carrying a manifest field this build does not read', () => {
    // A field no build here reads, which is the shape every later desktop field has.
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
    // The pairs still cross, so the page keeps the handoff rule it was built with rather than
    // falling back to "nobody told me" and handing every hop to the shell.
    expect(init.pageRouteGrants).toEqual([
      { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'haptics'] }
    ])
  })

  /**
   * One object for the measure and the measured, read off one `init`.
   *
   * `grants.native` is what this session may do and each pair is what the page compares a hop
   * against (`route-handoff.web.ts`). Both come from `routeViewOf`, so the pair for the pattern the
   * session was opened on must be the same list `grants.native` carries minus the protocol's own
   * grant. Two computations here is how a hop is kept local whose target then runs without the
   * capability it asked for.
   */
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
    expect(init.grants.native).toEqual([BRIDGE_FAULT_GRANT, ...view.routeGrants])
    const pair = (init.pageRouteGrants ?? []).find((entry) => entry.pathname === '/h/[hostId]')
    expect(pair?.grants).toEqual(view.routeGrants)
    // The optional name is in both, so the case is the lane and not two equal required lists.
    expect(init.grants.native).toContain('screencastBinary')
  })

  it('refuses a grant name the manifest grammar refuses, naming the field it came from', () => {
    // The host reads the manifest through the same grammar the desktop wrote it under, so a name
    // the bundle could not have declared cannot reach the page through this field either.
    const bridge = harness({
      pageRouteGrants: [{ pathname: '/h/[hostId]', grants: ['native.clipboard'] }]
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.posted.length).toBe(0)
    expect(bridge.routeRefusals).toHaveLength(1)
    const [reason] = bridge.routeRefusals
    // The prefix is the whole point: this route is well formed, so a reason that does not name the
    // field sends whoever reads the refusal to look at a pathname that was never the problem.
    expect(reason.startsWith('pageRouteGrants: ')).toBe(true)
    expect(reason.slice('pageRouteGrants: '.length)).not.toBe('')
    // The callback and the diagnostic are two readers of one verdict; they must not disagree.
    expect(bridge.diagnostics).toEqual([{ kind: 'route-refused', issue: reason }])
  })

  it('blames the route, not the pairs, when the route is the malformed one', () => {
    // The control for the case above. Both refusals arrive through one string, so without an
    // opener that fails for the other reason the prefix assertion holds on any reason at all.
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

  it('answers a ready for a refused route with nothing at all', async () => {
    // The page is still told it was heard, which is a different fact: a refused route has no
    // honest `init` behind it, so the ask is answered with no frame rather than with an empty one.
    // Unreachable from the session switch, which parses the route before it mounts the shell.
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
    // Nothing is retried and nothing is held: the page's own backoff asks again, and that ask is
    // answered with the route the shell holds then.
    expect(bridge.posted).toHaveLength(1)
    bridge.host.receive(clientFrame({ type: 'ready' }))
    expect(bridge.posted).toHaveLength(2)
  })

  /**
   * The repair path, pinned rather than described (ruling 34 addendum).
   *
   * A post is refused only when no document holds the view, and every one of those is followed by
   * a fresh document's `ready`. What makes that a repair is the held route advancing on `hold` as
   * well as on `send`: the tap arrives while the page cannot be sent one, and the next document is
   * answered with the route the tap wrote rather than the one the shell opened on.
   */
  it('answers the next document with the route a tap wrote while the view was gone', async () => {
    const view = { gone: true }
    const bridge = harness({
      route: { pathname: '/h/host-a/session/wt-1' },
      post: () => (view.gone ? Promise.reject(new Error('the view is gone')) : Promise.resolve())
    })
    // A page that declares nothing is never sent a second `init`, so the tap can only be held.
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.publishRoute({
      pathname: '/h/host-a/session/wt-1',
      params: { paneKey: 'pane-1' }
    })
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve()
    }
    expect(bridge.posted).toHaveLength(1)
    // The next document over the same host: a reload, or the view coming back.
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

  /**
   * The rollout half of ruling 33.6 (pullfrog).
   *
   * The page's own refusal only exists in a page built with it; a document served from an older
   * desktop bundle ignores `storageOversize` and writes the key anyway, which is the clobber the
   * ruling is about. The shell holds the same list on the `init` path, so it refuses there too and
   * an old page is refused as well.
   */
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
    // Nothing reaches native storage, so the entries the device holds survive the page.
    expect(bridge.storageWrites).toEqual([])
    expect(bridge.diagnostics).toEqual([{ kind: 'storage-refused', key: journal }])
    // And a key it did hand over is still writable, so the refusal is the size and not the path.
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
