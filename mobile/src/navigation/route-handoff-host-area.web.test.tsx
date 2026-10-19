/**
 * The hop the wide host-area session exists for: a worktree row in the page's own sidebar opening
 * the session screen inside the same document, decided by the page's real handoff rule against the
 * `init` the shell's real policy builds.
 */
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShellPageClient } from '../mobile-web-shell/bridge/page-bootstrap'
import { createBridgeInitFrame } from '../mobile-web-shell/bridge/bridge-init-frame'
import { routeViewOf, type MobileWebPageRoute } from '../mobile-web-shell/page-route-policy'
import type { RouteHandoff } from './route-handoff'

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  navigate: vi.fn(),
  dismissTo: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  setParams: vi.fn(),
  canGoBack: vi.fn(() => false)
}))

vi.mock('expo-router', () => ({ useRouter: () => router, usePathname: () => '/h/host-1' }))
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../transport/client-context.web'
import { useRouteHandoff } from './route-handoff.web'

const ROUTES: MobileWebPageRoute[] = [
  {
    pathname: '/h/[hostId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics'],
    canOwnHostArea: true
  },
  {
    pathname: '/h/[hostId]/tasks',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  {
    pathname: '/h/[hostId]/session/[worktreeId]',
    grants: [
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
    ],
    optionalGrants: ['externalNavigation']
  }
]

const held: { handoff: RouteHandoff | null } = { handoff: null }

function Screen(): null {
  held.handoff = useRouteHandoff()
  return null
}

/** The page holding the `init` the shell builds for this route at this layout class. */
function mountPage(
  pathname: string,
  wide: boolean
): { handoff: RouteHandoff; navigations: () => number } {
  const posted: string[] = []
  const channel: {
    postMessage: (json: string) => void
    onmessage: ((event: { data: string }) => void) | null
  } = { postMessage: (json) => posted.push(json), onmessage: null }
  Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
  const client = createShellPageClient()
  if (client === null) {
    throw new Error('no channel installed')
  }
  const view = routeViewOf(ROUTES, pathname, wide)
  const init = createBridgeInitFrame({
    sessionId: 'session-a',
    buildId: 'build-a',
    connection: {
      state: 'connected',
      reconnectAttempt: 0,
      lastConnectedAt: 1,
      lastInboundAt: 1,
      generation: 0
    },
    route: { pathname },
    pageRoutes: view.pageRoutes,
    pageRouteGrants: view.pageRouteGrants,
    granted: ['fault', ...view.routeGrants],
    host: { id: 'host-1', name: 'Host', endpoint: 'ws://h', lastConnected: 0 },
    storage: {},
    ownsHostArea: view.ownsHostArea
  })
  channel.onmessage?.({ data: JSON.stringify(init) })
  act(() => {
    create(
      <RpcClientProvider client={client}>
        <Screen />
      </RpcClientProvider>
    )
  })
  if (held.handoff === null) {
    throw new Error('no screen mounted')
  }
  const handoff = held.handoff
  return {
    handoff,
    navigations: () =>
      posted.map((json) => JSON.parse(json)).filter((frame) => frame.name === 'navigate').length
  }
}

beforeEach(() => {
  held.handoff = null
  vi.clearAllMocks()
})

describe('a worktree row in the host-area page', () => {
  it('opens the session inside this document, without a native push', () => {
    const page = mountPage('/h/host-1', true)
    page.handoff.push('/h/host-1/session/wt-1?name=main')
    expect(router.push).toHaveBeenCalledWith('/h/host-1/session/wt-1?name=main', undefined)
    expect(page.navigations()).toBe(0)
  })

  it('switches workspaces in place too, which the embedded sidebar does with a replace', () => {
    const page = mountPage('/h/host-1', true)
    page.handoff.replace('/h/host-1/session/wt-2')
    expect(router.replace).toHaveBeenCalledWith('/h/host-1/session/wt-2', undefined)
    expect(page.navigations()).toBe(0)
  })

  it('is still handed to the shell from a phone host page, whose grants do not cover it', () => {
    const page = mountPage('/h/host-1', false)
    page.handoff.push('/h/host-1/session/wt-1')
    expect(router.push).not.toHaveBeenCalled()
    expect(page.navigations()).toBe(1)
  })
})

describe('a session page opened on its own, leaving for the host route', () => {
  // A missing worktree's notice and the session's own way out both replace to the host route.
  const hop = '/h/host-1?notice=worktree-missing'

  it('hands the hop to the shell on a wide layout, which opens the area-owning session', () => {
    const page = mountPage('/h/host-1/session/wt-1', true)
    page.handoff.replace(hop)
    expect(router.replace).not.toHaveBeenCalled()
    expect(page.navigations()).toBe(1)
    expect(routeViewOf(ROUTES, '/h/host-1', true).ownsHostArea).toBe(true)
  })

  it('keeps it in this document on a phone, as before', () => {
    const page = mountPage('/h/host-1/session/wt-1', false)
    page.handoff.replace(hop)
    expect(router.replace).toHaveBeenCalledWith(hop, undefined)
    expect(page.navigations()).toBe(0)
  })
})
