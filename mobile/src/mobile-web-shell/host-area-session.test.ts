import { describe, expect, it } from 'vitest'
import {
  computeMobileWebBundleId,
  MobileWebBundleRouteSchema
} from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MobileWebBundleManifestReadSchema } from '../transport/mobile-web-bundle-reply-schemas'
import { createBridgeInitFrame } from './bridge/bridge-init-frame'
import { readBridgeHostMessage } from './bridge/bridge-envelope'
import { readShellSession } from './bridge/bridge-client-session'
import {
  createMobileWebShellSession,
  gates,
  MANIFEST_WIRE,
  manifestFacts,
  run
} from './mobile-web-shell-session-test-fixtures'
import { routeViewOf, type MobileWebPageRoute } from './page-route-policy'

const HOST_ROUTE = '/h/host-1'
const SESSION_GRANTS = [
  'navigate',
  'storage',
  'externalLink',
  'haptics',
  'screencastBinary',
  'native.clipboard.write',
  'native.clipboard.read',
  'native.media.pick',
  'native.media.read',
  'native.media.release',
  'native.audio.start',
  'native.audio.read',
  'native.audio.stop'
]

function desktopRoutes(declares: boolean): MobileWebPageRoute[] {
  return [
    {
      pathname: '/h/[hostId]',
      grants: ['navigate', 'storage', 'externalLink', 'haptics'],
      ...(declares ? { canOwnHostArea: true } : {})
    },
    {
      pathname: '/h/[hostId]/tasks',
      grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
    },
    {
      pathname: '/h/[hostId]/files/[worktreeId]',
      grants: ['navigate', 'storage', 'externalLink', 'haptics']
    },
    {
      pathname: '/h/[hostId]/session/[worktreeId]',
      grants: SESSION_GRANTS,
      optionalGrants: ['externalNavigation']
    }
  ]
}

function wideStateFor(routes: MobileWebPageRoute[] | null, pathname = HOST_ROUTE) {
  const opened = run(
    createMobileWebShellSession(pathname),
    { type: 'layout-changed', wide: true },
    { type: 'gates-changed', gates: routes === null ? gates({ hostCapabilities: [] }) : gates() }
  )
  if (routes === null) {
    return opened.session
  }
  return run(
    opened.session,
    { type: 'cache-read', generation: null },
    { type: 'manifest-read', manifest: manifestFacts({ ...MANIFEST_WIRE, routes }) }
  ).session
}

describe('the page declaring it can own the host area', () => {
  it('accepts a true ownership declaration from the desktop and refuses false', () => {
    const [host] = desktopRoutes(true)
    expect(MobileWebBundleRouteSchema.safeParse(host).success).toBe(true)
    // Only true declares ownership; false must be rejected.
    expect(MobileWebBundleRouteSchema.safeParse({ ...host, canOwnHostArea: false }).success).toBe(
      false
    )
  })

  it('reads a value this build cannot read as no declaration, not a refused bundle', () => {
    const parsed = MobileWebBundleManifestReadSchema.safeParse({
      ...MANIFEST_WIRE,
      buildId: computeMobileWebBundleId(MANIFEST_WIRE.assets),
      routes: [{ pathname: '/h/[hostId]', grants: ['navigate'], canOwnHostArea: 'yes' }]
    })
    expect(parsed.success).toBe(true)
    expect(routeViewOf(parsed.data?.routes, HOST_ROUTE, true).ownsHostArea).toBe(false)
  })

  it('gives the area to the host route of a page this shell would serve, on a wide layout only', () => {
    expect(routeViewOf(desktopRoutes(true), HOST_ROUTE, true).ownsHostArea).toBe(true)
    expect(routeViewOf(desktopRoutes(true), HOST_ROUTE).ownsHostArea).toBe(false)
    expect(routeViewOf(desktopRoutes(false), HOST_ROUTE, true).ownsHostArea).toBe(false)
    expect(routeViewOf(desktopRoutes(true), '/h/host-1/tasks', true).ownsHostArea).toBe(false)
    const unserved = [{ ...desktopRoutes(true)[0]!, grants: ['native.teleport.start'] }]
    expect(routeViewOf(unserved, HOST_ROUTE, true).ownsHostArea).toBe(false)
  })

  it('keeps the area at either width only for a page that declares it across layouts', () => {
    const [host, ...rest] = desktopRoutes(true)
    const routes = [{ ...host!, canOwnHostAreaAcrossLayouts: true }, ...rest]
    expect(routeViewOf(routes, HOST_ROUTE, true).ownsHostArea).toBe(true)
    expect(routeViewOf(routes, HOST_ROUTE, false).ownsHostArea).toBe(true)
    // A narrow detail session hands a hop to the host route back to the shell, like a wide one.
    expect(
      routeViewOf(routes, '/h/host-1/session/wt-1', false).pageRouteGrants.map((p) => p.pathname)
    ).not.toContain('/h/[hostId]')
    // Without `canOwnHostArea` the across-layouts flag claims nothing.
    const flagOnly = [{ ...desktopRoutes(false)[0]!, canOwnHostAreaAcrossLayouts: true }]
    expect(routeViewOf(flagOnly, HOST_ROUTE, false).ownsHostArea).toBe(false)
    expect(routeViewOf(flagOnly, HOST_ROUTE, true).ownsHostArea).toBe(false)
  })

  it.each(['/h/[hostId]', '/h/[...page]'])(
    'does not combine ownership declarations from a separate matching %s route',
    (acrossLayoutsPattern) => {
      const [host, ...details] = desktopRoutes(true)
      const routes = [
        host!,
        {
          pathname: acrossLayoutsPattern,
          grants: ['navigate'],
          canOwnHostAreaAcrossLayouts: true
        },
        ...details
      ]
      const parsed = MobileWebBundleManifestReadSchema.parse({
        ...MANIFEST_WIRE,
        buildId: computeMobileWebBundleId(MANIFEST_WIRE.assets),
        routes
      })
      expect(routeViewOf(parsed.routes, HOST_ROUTE, false).ownsHostArea).toBe(false)
      expect(routeViewOf(parsed.routes, HOST_ROUTE, true).ownsHostArea).toBe(true)
      expect(
        routeViewOf(parsed.routes, '/h/host-1/session/wt-1', false).pageRouteGrants.map(
          (pair) => pair.pathname
        )
      ).toContain('/h/[hostId]')
    }
  )
})

describe('the wide host-area session', () => {
  it("is granted every served route's grants, and no phone session is", () => {
    const view = routeViewOf(desktopRoutes(true), HOST_ROUTE, true)
    expect([...view.routeGrants].sort()).toEqual(
      [...SESSION_GRANTS, 'externalNavigation', 'native.storage.read'].sort()
    )
    for (const pair of view.pageRouteGrants) {
      expect(pair.grants.every((grant) => view.routeGrants.includes(grant))).toBe(true)
    }
    expect(routeViewOf(desktopRoutes(true), HOST_ROUTE).routeGrants).toEqual([
      'navigate',
      'storage',
      'externalLink',
      'haptics'
    ])
  })

  it('serves nothing against a page that cannot own the area', () => {
    expect(routeViewOf(desktopRoutes(false), HOST_ROUTE, true)).toEqual({
      pageRoutes: [],
      pageRouteGrants: [],
      routeGrants: [],
      ownsHostArea: false
    })
  })

  it('walls the desktop for no page and for a page without the declaration, host route or detail', () => {
    for (const pathname of [HOST_ROUTE, '/h/host-1/session/wt-1']) {
      expect(wideStateFor(null, pathname).state).toEqual({
        kind: 'wall',
        verdict: { kind: 'blocked', reason: 'bundle-unavailable' }
      })
      expect(wideStateFor(desktopRoutes(false), pathname).state).toEqual({
        kind: 'wall',
        verdict: { kind: 'blocked', reason: 'page-route-unlisted' }
      })
    }
  })

  it('fetches the declaring page for the host route with every grant', () => {
    const session = wideStateFor(desktopRoutes(true))
    expect(session.state.kind).toBe('fetching')
    expect(session.routeGrants).toContain('native.audio.start')
  })

  it("serves a wide detail route under a declaring page with that route's own grants", () => {
    const session = wideStateFor(desktopRoutes(true), '/h/host-1/files/wt-1')
    expect(session.state.kind).toBe('fetching')
    expect(session.routeGrants).toEqual(['navigate', 'storage', 'externalLink', 'haptics'])
  })

  it('serves a wide route only under the host route of a declaring page', () => {
    expect(routeViewOf(desktopRoutes(true), '/h/host-1/session/wt-1', true).pageRoutes).not.toEqual(
      []
    )
    for (const pathname of ['/h/', '/settings']) {
      expect(routeViewOf(desktopRoutes(true), pathname, true).pageRoutes).toEqual([])
    }
  })
})

describe('a layout change on a mounted session', () => {
  function narrowStateFor(routes: MobileWebPageRoute[], pathname: string) {
    return run(
      createMobileWebShellSession(pathname),
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: null },
      { type: 'manifest-read', manifest: manifestFacts({ ...MANIFEST_WIRE, routes }) }
    ).session
  }

  it('restarts a declared detail session, whose page may no longer keep the host-route hop', () => {
    const narrow = narrowStateFor(desktopRoutes(true), '/h/host-1/files/wt-1')
    expect(narrow.pageRouteGrants.map((pair) => pair.pathname)).toContain('/h/[hostId]')
    const wide = run(narrow, { type: 'layout-changed', wide: true })
    expect(wide.session.flow).toBe(narrow.flow + 1)
    expect(wide.effects).toEqual([{ kind: 'open-cache' }])
    const served = run(
      wide.session,
      { type: 'cache-read', generation: null },
      {
        type: 'manifest-read',
        manifest: manifestFacts({ ...MANIFEST_WIRE, routes: desktopRoutes(true) })
      }
    ).session
    expect(served.pageRouteGrants.map((pair) => pair.pathname)).not.toContain('/h/[hostId]')
  })

  it('restarts a detail session an undeclaring page may not serve wide', () => {
    const narrow = narrowStateFor(desktopRoutes(false), '/h/host-1/files/wt-1')
    const wide = run(narrow, { type: 'layout-changed', wide: true }).session
    expect(wide.flow).toBe(narrow.flow + 1)
    expect(wide.state.kind).toBe('checking')
    expect(wide.wide).toBe(true)
  })

  it('restarts the host route, whose view changes with the layout', () => {
    const narrow = narrowStateFor(desktopRoutes(true), HOST_ROUTE)
    const wide = run(narrow, { type: 'layout-changed', wide: true })
    expect(wide.session.flow).toBe(narrow.flow + 1)
    expect(wide.effects).toEqual([{ kind: 'open-cache' }])
    const served = run(
      wide.session,
      { type: 'cache-read', generation: null },
      {
        type: 'manifest-read',
        manifest: manifestFacts({ ...MANIFEST_WIRE, routes: desktopRoutes(true) })
      }
    ).session
    expect(served.ownsHostArea).toBe(true)
    expect(served.routeGrants).toContain('native.storage.read')
  })
})

describe('the init fact', () => {
  function init(ownsHostArea: boolean | undefined) {
    return createBridgeInitFrame({
      sessionId: 's',
      buildId: 'b',
      connection: {
        state: 'connected',
        reconnectAttempt: 0,
        lastConnectedAt: null,
        lastInboundAt: null,
        generation: null
      },
      route: { pathname: HOST_ROUTE },
      pageRoutes: [],
      granted: [],
      host: { id: 'host-1', name: 'Host', endpoint: 'ws://h', lastConnected: 0 },
      storage: {},
      ...(ownsHostArea === undefined ? {} : { ownsHostArea })
    })
  }

  it('crosses only for the host-area session, and is absent otherwise', () => {
    expect(init(true).ownsHostArea).toBe(true)
    expect('ownsHostArea' in init(false)).toBe(false)
    expect('ownsHostArea' in init(undefined)).toBe(false)
  })

  it('reads as false from every shell that predates it, and from a value it cannot read', () => {
    const parse = (frame: unknown) => {
      const read = readBridgeHostMessage(JSON.stringify(frame))
      if (!read.ok || read.message.type !== 'init') {
        throw new Error('init refused')
      }
      return readShellSession(read.message).ownsHostArea
    }
    expect(parse(init(true))).toBe(true)
    expect(parse(init(undefined))).toBe(false)
    expect(parse({ ...init(undefined), ownsHostArea: 'all of it' })).toBe(false)
  })
})
