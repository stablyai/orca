import type { ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_MAX_ROUTE_HREF_CHARS } from '../mobile-web-shell/bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import { createShellPageClient } from '../mobile-web-shell/bridge/page-bootstrap'
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

vi.mock('expo-router', () => ({ useRouter: () => router, usePathname: () => '/' }))
// Stub re-exported hooks to avoid importing Expo; these tests call none of them.
vi.mock('../transport/connection/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../transport/connection/client-context.web'
import { useRouteHandoff } from './route-handoff.web'

const INIT = {
  v: BRIDGE_PROTOCOL_VERSION,
  type: 'init',
  sessionId: 'session-a',
  buildId: 'build-a',
  connection: {
    state: 'connected',
    reconnectAttempt: 0,
    lastConnectedAt: 1,
    lastInboundAt: 1,
    generation: 0
  },
  grants: { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: ['navigate'] },
  route: { pathname: '/h/host-a' },
  pageRoutes: ['/h/[hostId]']
}

const trees: ReactTestRenderer[] = []
const clients: BridgeRpcClient[] = []

const held: { handoff: RouteHandoff | null } = { handoff: null }

function Screen(): null {
  held.handoff = useRouteHandoff()
  return null
}

function installChannel(): {
  posted: string[]
  deliver: (frame: unknown) => void
  failPosts: () => void
} {
  let failed = false
  const posted: string[] = []
  const channel: {
    postMessage: (json: string) => void
    onmessage: ((event: { data: string }) => void) | null
  } = {
    postMessage: (json) => {
      if (failed) {
        throw new Error('page port unavailable')
      }
      posted.push(json)
    },
    onmessage: null
  }
  Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
  return {
    posted,
    failPosts: () => {
      failed = true
    },
    deliver: (frame) => {
      channel.onmessage?.({ data: JSON.stringify(frame) })
    }
  }
}

function mount(init: unknown): { posted: string[]; handoff: RouteHandoff; failPosts: () => void } {
  const channel = installChannel()
  const client = createShellPageClient()
  if (client === null) {
    throw new Error('no channel installed')
  }
  clients.push(client)
  channel.deliver(init)
  act(() => {
    trees.push(create(render(client)))
  })
  const handoff = held.handoff
  if (handoff === null) {
    throw new Error('no screen mounted')
  }
  return { posted: channel.posted, handoff, failPosts: channel.failPosts }
}

function render(client: BridgeRpcClient): ReactElement {
  return (
    <RpcClientProvider client={client}>
      <Screen />
    </RpcClientProvider>
  )
}

function navigations(posted: readonly string[]): unknown[] {
  return posted
    .map((json) => JSON.parse(json))
    .filter((frame: { name?: string }) => frame.name === 'navigate')
}

const warned: unknown[][] = []
let restoreWarn: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  held.handoff = null
  warned.length = 0
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warned.push(args)
  }
  restoreWarn = () => {
    console.warn = original
  }
  router.push.mockClear()
  router.replace.mockClear()
  router.navigate.mockClear()
  router.dismissTo.mockClear()
  router.prefetch.mockClear()
  router.back.mockClear()
  router.setParams.mockClear()
  router.canGoBack.mockClear()
  router.canGoBack.mockReturnValue(false)
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
  restoreWarn?.()
  restoreWarn = null
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'orcaBridge')
})

describe('a shell that granted no navigate', () => {
  it('stays where it is rather than mounting a screen this page does not serve', () => {
    // A local fallback would mount an unsupported native screen under RN Web because the bundle contains app/h; refusal must stay put.
    const { posted, handoff } = mount({
      ...INIT,
      grants: { ...INIT.grants, native: [] },
      pageRoutes: []
    })
    handoff.push('/h/host-a/session/wt-1')
    expect(navigations(posted)).toEqual([])
    expect(router.push).not.toHaveBeenCalled()
  })
})

// Validate hrefs before posting: notifyNavigate reports send handoff, not whether the shell accepted its target.
describe('a target the shell would refuse', () => {
  it('refuses an href the pattern refuses, rather than opening it here instead', () => {
    for (const href of [
      '/h/host-a/tasks#top',
      '/h/host-a/../tasks',
      '/h/host-a/%2e%2e/tasks',
      '/h/a\\b/tasks'
    ]) {
      router.push.mockClear()
      const { posted, handoff } = mount(INIT)
      handoff.push(href)
      expect(navigations(posted), href).toEqual([])
      expect(router.push, href).not.toHaveBeenCalled()
    }
  })

  it('refuses a target over the href cap', () => {
    const { posted, handoff } = mount(INIT)
    const href = `/h/host-a/${'a'.repeat(BRIDGE_MAX_ROUTE_HREF_CHARS)}`
    handoff.push(href)
    expect(navigations(posted)).toEqual([])
    expect(router.push).not.toHaveBeenCalled()
  })
})

// Wrap every href-taking router member; spreading navigate/prefetch untouched would bypass page-route policy.

// Never hand prefetch to native navigate: a background optimization must not open a screen.
describe('prefetch', () => {
  it('never posts a navigate for one it does not, and does not open it locally either', () => {
    const { posted, handoff } = mount(INIT)
    handoff.prefetch('/h/host-a/session/wt-1')
    expect(navigations(posted)).toEqual([])
    expect(router.prefetch).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })
})
