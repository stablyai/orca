// Use real shell policy and page handoff to verify wide host sidebar hops stay inside the owning document.
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createShellPageClient } from '../mobile-web-shell/bridge/page-bootstrap'
import { createBridgeInitFrame } from '../mobile-web-shell/bridge/bridge-init-frame'
import { routeViewOf, type MobileWebPageRoute } from '../mobile-web-shell/page-route-policy'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
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
    canOwnHostArea: true,
    canOwnHostAreaAcrossLayouts: true
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

const trees: ReactTestRenderer[] = []
const clients: BridgeRpcClient[] = []

const held: { handoff: RouteHandoff | null } = { handoff: null }

function Screen(): null {
  held.handoff = useRouteHandoff()
  return null
}

function mountPage(
  pathname: string,
  wide: boolean
): { handoff: RouteHandoff; navigations: () => unknown[] } {
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
  clients.push(client)
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
    trees.push(
      create(
        <RpcClientProvider client={client}>
          <Screen />
        </RpcClientProvider>
      )
    )
  })
  if (held.handoff === null) {
    throw new Error('no screen mounted')
  }
  const handoff = held.handoff
  return {
    handoff,
    navigations: () =>
      posted.map((json) => JSON.parse(json)).filter((frame) => frame.name === 'navigate')
  }
}

beforeEach(() => {
  held.handoff = null
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
  for (const client of clients.splice(0)) {
    client.close()
  }
  Reflect.deleteProperty(globalThis, 'orcaBridge')
})

describe('a worktree row in the host-area page', () => {
  it('opens the session inside this document, without a native push', () => {
    const page = mountPage('/h/host-1', true)
    page.handoff.push('/h/host-1/session/wt-1?name=main')
    expect(router.push).toHaveBeenCalledWith('/h/host-1/session/wt-1?name=main', undefined)
    expect(page.navigations()).toEqual([])
  })

  it('switches workspaces in place too, which the embedded sidebar does with a replace', () => {
    const page = mountPage('/h/host-1', true)
    page.handoff.replace('/h/host-1/session/wt-2')
    expect(router.replace).toHaveBeenCalledWith('/h/host-1/session/wt-2', undefined)
    expect(page.navigations()).toEqual([])
  })

  it('keeps a workspace in the same declaring host document on a narrow viewport too', () => {
    const page = mountPage('/h/host-1', false)
    page.handoff.push('/h/host-1/session/wt-1')
    expect(router.push).toHaveBeenCalledWith('/h/host-1/session/wt-1', undefined)
    expect(page.navigations()).toEqual([])
  })
})

describe('a session page opened on its own, leaving for the host route', () => {
  const hop = '/h/host-1?notice=worktree-missing'

  it('hands the hop to the shell on a wide layout, which opens the area-owning session', () => {
    const page = mountPage('/h/host-1/session/wt-1', true)
    page.handoff.replace(hop)
    expect(router.replace).not.toHaveBeenCalled()
    expect(page.navigations()).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'navigate', href: hop, replace: true }
    ])
    expect(routeViewOf(ROUTES, '/h/host-1', true).ownsHostArea).toBe(true)
  })

  it('returns a narrow detail document to the same shell-owned host area', () => {
    const page = mountPage('/h/host-1/session/wt-1', false)
    page.handoff.replace(hop)
    expect(router.replace).not.toHaveBeenCalled()
    expect(page.navigations()).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'navigate', href: hop, replace: true }
    ])
  })
})
