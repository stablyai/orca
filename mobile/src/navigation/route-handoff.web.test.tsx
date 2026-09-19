import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_MAX_ROUTE_HREF_CHARS } from '../mobile-web-shell/bridge/bridge-caps'
import {
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION
} from '../mobile-web-shell/bridge/bridge-envelope'
import { createShellPageClient } from '../mobile-web-shell/bridge/page-bootstrap'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import type { RouteHandoff } from './route-handoff'

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  dismissTo: vi.fn(),
  back: vi.fn(),
  /** What the page's own stack answers. One entry is what the entry's `replaceState` leaves. */
  canGoBack: vi.fn(() => false)
}))

vi.mock('expo-router', () => ({ useRouter: () => router }))
// The web file re-exports the screen hooks through the provider module, and reaching the real ones
// imports the Expo runtime this test does not have. Nothing below calls one.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => () => Promise.resolve(),
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../transport/client-context.web'
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

const held: { handoff: RouteHandoff | null } = { handoff: null }

function Screen(): null {
  held.handoff = useRouteHandoff()
  return null
}

function installChannel(): { posted: string[]; deliver: (frame: unknown) => void } {
  const posted: string[] = []
  const channel: {
    postMessage: (json: string) => void
    onmessage: ((event: { data: string }) => void) | null
  } = {
    postMessage: (json) => {
      posted.push(json)
    },
    onmessage: null
  }
  Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
  return {
    posted,
    deliver: (frame) => {
      channel.onmessage?.({ data: JSON.stringify(frame) })
    }
  }
}

/** The page as the entry leaves it: one client, already holding a session. */
function mount(init: unknown): { posted: string[]; handoff: RouteHandoff } {
  const channel = installChannel()
  const client = createShellPageClient()
  if (client === null) {
    throw new Error('no channel installed')
  }
  channel.deliver(init)
  act(() => {
    create(render(client))
  })
  const handoff = held.handoff
  if (handoff === null) {
    throw new Error('no screen mounted')
  }
  return { posted: channel.posted, handoff }
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

function backs(posted: readonly string[]): unknown[] {
  return posted
    .map((json) => JSON.parse(json))
    .filter((frame: { name?: string }) => frame.name === BRIDGE_NAVIGATE_BACK_NOTIFY)
}

beforeEach(() => {
  vi.useFakeTimers()
  held.handoff = null
  router.push.mockClear()
  router.replace.mockClear()
  router.dismissTo.mockClear()
  router.back.mockClear()
  router.canGoBack.mockClear()
  router.canGoBack.mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'orcaBridge')
})

describe('a route the page does not render', () => {
  it('goes to the shell, and nowhere inside this document', () => {
    const { posted, handoff } = mount(INIT)
    handoff.push('/h/host-a/session/wt-1?name=a+b')
    expect(navigations(posted)).toEqual([
      {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'navigate',
        href: '/h/host-a/session/wt-1?name=a+b'
      }
    ])
    expect(router.push).not.toHaveBeenCalled()
  })

  it('goes to the shell on a replace too, because the shell only knows how to push', () => {
    const { posted, handoff } = mount(INIT)
    handoff.replace('/h/host-a/tasks')
    expect(navigations(posted)).toHaveLength(1)
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('reads the path and not the query, so a target with params is still matched', () => {
    const { posted, handoff } = mount(INIT)
    handoff.push('/h/host-b?from=list')
    // `/h/host-b` is a page route; the query is not part of what the pattern matches.
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-b?from=list')
  })
})

describe('a route the page does render', () => {
  it('stays in this document rather than re-entering the shell for it', () => {
    const { posted, handoff } = mount(INIT)
    handoff.push('/h/host-b')
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-b')
  })

  it('replaces locally, which is a history entry the native stack never had', () => {
    const { handoff } = mount(INIT)
    handoff.replace('/h/host-b')
    expect(router.replace).toHaveBeenCalledWith('/h/host-b')
  })
})

describe('the members that stay inside this document', () => {
  it('keeps a back this document can serve itself', () => {
    router.canGoBack.mockReturnValue(true)
    const { posted, handoff } = mount(INIT)
    handoff.back()
    expect(router.back).toHaveBeenCalled()
    expect(backs(posted)).toEqual([])
  })

  it('hand the way out of the host over, since home is a native route', () => {
    const { posted, handoff } = mount(INIT)
    handoff.dismissTo('/')
    expect(navigations(posted)).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'navigate', href: '/' }
    ])
    expect(router.dismissTo).not.toHaveBeenCalled()
  })
})

describe('a shell that granted no navigate', () => {
  it('falls through to this document rather than doing nothing at all', () => {
    // Unmatched is a worse screen than the one the page is on, and a tap that does nothing is
    // worse than both. The route policy is what keeps this case off a device: a shell with no
    // `navigate` renders no page route in the first place.
    const { posted, handoff } = mount({
      ...INIT,
      grants: { ...INIT.grants, native: [] },
      pageRoutes: []
    })
    handoff.push('/h/host-a/tasks')
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-a/tasks')
  })
})

/**
 * Two hrefs the page actually builds that the shell would have dropped.
 *
 * `notifyNavigate` answers whether the frame left the page, never whether the shell took it, so
 * both of these used to suppress the local fallback and leave a dead tap.
 */
describe('a target the shell would refuse', () => {
  it('resolves the object form the Connection-log link builds, rather than posting [object Object]', () => {
    const { posted, handoff } = mount(INIT)
    // host-workspace-list.tsx renders this whenever a host is reconnecting with three attempts.
    handoff.push({ pathname: '/connection-log', params: { hostId: 'host a/b' } })
    expect(navigations(posted)).toEqual([
      {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'navigate',
        href: '/connection-log?hostId=host+a%2Fb'
      }
    ])
    expect(router.push).not.toHaveBeenCalled()
  })

  it('fills a dynamic segment from its own param, the way the router does', () => {
    const { posted, handoff } = mount({ ...INIT, pageRoutes: [] })
    handoff.push({ pathname: '/h/[hostId]/tasks', params: { hostId: 'host-b', from: 'list' } })
    expect(navigations(posted)).toEqual([
      {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'navigate',
        href: '/h/host-b/tasks?from=list'
      }
    ])
  })

  it('falls through locally for an href the pattern refuses, instead of a tap that does nothing', () => {
    for (const href of [
      '/h/host-a/tasks#top',
      '/h/host-a/../tasks',
      // The same climb the shell's reader refuses percent-encoded, which both sides get from the
      // one segment rule they share.
      '/h/host-a/%2e%2e/tasks',
      '/h/a\\b/tasks'
    ]) {
      router.push.mockClear()
      const { posted, handoff } = mount(INIT)
      handoff.push(href)
      // Posted whole before this: `pathnameOf` strips the fragment to match, and the unstripped
      // href went on the wire and was dropped by the shell's reader.
      expect(navigations(posted), href).toEqual([])
      expect(router.push, href).toHaveBeenCalledWith(href)
    }
  })

  it('falls through for a target over the href cap', () => {
    const { posted, handoff } = mount(INIT)
    const href = `/h/host-a/${'a'.repeat(BRIDGE_MAX_ROUTE_HREF_CHARS)}`
    handoff.push(href)
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith(href)
  })
})

/**
 * The Back button the page could not serve.
 *
 * The document holds the one history entry the entry wrote with `replaceState`, so `history.back()`
 * goes nowhere and the Tasks header's `onPress={() => router.back()}`
 * (`src/tasks/mobile-tasks-screen-chrome.tsx`) is dead inside the page. The stack that has
 * somewhere to go is the native one the shell pushed this page onto.
 */
describe('a back this document cannot serve', () => {
  it('hands the pop to the shell rather than going nowhere', () => {
    const { posted, handoff } = mount(INIT)
    // Exactly the call the Tasks header makes from its own tap handler.
    handoff.back()
    expect(backs(posted)).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }
    ])
    expect(router.back).not.toHaveBeenCalled()
  })

  it('falls through to this document when the shell granted no navigate', () => {
    const { posted, handoff } = mount({
      ...INIT,
      grants: { ...INIT.grants, native: [] },
      pageRoutes: []
    })
    handoff.back()
    expect(backs(posted)).toEqual([])
    expect(router.back).toHaveBeenCalled()
  })

  it('does not throw out of a tap handler when there is nowhere to post', () => {
    const { handoff } = mount({ ...INIT, grants: { ...INIT.grants, native: [] } })
    expect(() => handoff.back()).not.toThrow()
  })
})
