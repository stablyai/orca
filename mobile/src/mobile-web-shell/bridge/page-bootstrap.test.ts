import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import type { OrcaBridgePageChannel } from './orca-bridge-page-channel'
import {
  bootstrapShellPage,
  createShellPageClient,
  PAGE_BUILD_ID_KEY,
  PAGE_MOUNT_STATE_KEY,
  PAGE_SESSION_ID_KEY,
  shellRouteHref,
  stampPageMountState,
  type PageMountTarget
} from './page-bootstrap'
import type { BridgeRpcClient, BridgeShellSession } from './bridge-rpc-client'

const INIT = {
  v: BRIDGE_PROTOCOL_VERSION,
  type: 'init',
  sessionId: 'session-a',
  buildId: 'build-a',
  connection: {
    state: 'connected',
    reconnectAttempt: 0,
    lastConnectedAt: 1700,
    lastInboundAt: 1800,
    generation: 3
  },
  grants: { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: [] },
  route: { pathname: '/h/host-a' }
}

function createTarget(): PageMountTarget {
  return { dataset: {} }
}

/** The channel the shell's document-start script installs, as a double. */
function installChannel(): { posted: string[]; deliver: (frame: unknown) => void } {
  const posted: string[] = []
  const channel: OrcaBridgePageChannel = {
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

type Mounted = { client: BridgeRpcClient; session: BridgeShellSession }

/** Everything the page did to its document, in the order it did it. */
type Page = {
  mounts: Mounted[]
  urls: string[]
  refusals: number
  /** One list, because what matters is which came first: routing after a render is a render at `/`. */
  order: string[]
  client: BridgeRpcClient | null
}

function bootstrap(target: PageMountTarget): Page {
  const page: Page = { mounts: [], urls: [], refusals: 0, order: [], client: null }
  page.client = createShellPageClient()
  bootstrapShellPage({
    target,
    client: page.client,
    replaceUrl: (href) => {
      page.urls.push(href)
      page.order.push('replaceUrl')
    },
    mount: (client, session) => {
      page.mounts.push({ client, session })
      page.order.push('mount')
    },
    refuseUnroutedShell: () => {
      page.refusals += 1
      page.order.push('refuse')
    }
  })
  return page
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'orcaBridge')
})

describe('the page bootstrap inside the shell', () => {
  it('asks for a session and does nothing to the document until the shell answers', () => {
    const channel = installChannel()
    const target = createTarget()
    const page = bootstrap(target)

    expect(channel.posted.map((json) => JSON.parse(json).type)).toEqual(['ready'])
    expect(page.order).toEqual([])
    expect(target.dataset[PAGE_MOUNT_STATE_KEY]).toBeUndefined()
    // The handshake keeps asking rather than waiting out an `init` that has been and gone, and
    // still nothing is routed or mounted while it does.
    vi.advanceTimersByTime(5_000)
    expect(channel.posted.length).toBeGreaterThan(1)
    expect(page.order).toEqual([])
  })

  it('routes before it mounts, so the router never reads the one path no screen claims', () => {
    const channel = installChannel()
    const target = createTarget()
    const page = bootstrap(target)

    channel.deliver(INIT)

    expect(page.order).toEqual(['replaceUrl', 'mount'])
    expect(page.urls).toEqual(['/h/host-a'])
    expect(page.mounts[0]?.client).toBe(page.client)
    expect(page.mounts[0]?.session.route).toEqual({ pathname: '/h/host-a' })
    expect(target.dataset[PAGE_MOUNT_STATE_KEY]).toBe('shell-ready')
    expect(target.dataset[PAGE_SESSION_ID_KEY]).toBe('session-a')
    expect(target.dataset[PAGE_BUILD_ID_KEY]).toBe('build-a')
  })

  it('carries the params the screen was opened with into the url it writes', () => {
    const channel = installChannel()
    const page = bootstrap(createTarget())

    channel.deliver({
      ...INIT,
      route: { pathname: '/h/host-a/session/wt-1', params: { name: 'fix the bug' } }
    })

    expect(page.urls).toEqual(['/h/host-a/session/wt-1?name=fix+the+bug'])
  })

  it('stamps the session before it routes, so a tree that throws still names its build', () => {
    const channel = installChannel()
    const target = createTarget()
    const client = createShellPageClient()
    bootstrapShellPage({
      target,
      client,
      replaceUrl: () => {},
      mount: () => {
        expect(target.dataset[PAGE_BUILD_ID_KEY]).toBe('build-a')
        throw new Error('the route tree threw')
      },
      refuseUnroutedShell: () => {}
    })

    expect(() => {
      channel.deliver(INIT)
    }).toThrow('the route tree threw')
    expect(target.dataset[PAGE_MOUNT_STATE_KEY]).toBe('shell-ready')
  })

  it('mounts one tree for one document, whatever the shell sends next', () => {
    const channel = installChannel()
    const target = createTarget()
    const page = bootstrap(target)

    channel.deliver(INIT)
    channel.deliver({ ...INIT, sessionId: 'session-b', route: { pathname: '/h/host-b' } })

    expect(page.order).toEqual(['replaceUrl', 'mount'])
    expect(target.dataset[PAGE_SESSION_ID_KEY]).toBe('session-a')
  })

  it('mounts at once when the client already holds a session', () => {
    const channel = installChannel()
    const client = createShellPageClient()
    channel.deliver(INIT)
    const target = createTarget()
    const order: string[] = []

    bootstrapShellPage({
      target,
      client,
      replaceUrl: () => order.push('replaceUrl'),
      mount: () => order.push('mount'),
      refuseUnroutedShell: () => order.push('refuse')
    })

    expect(order).toEqual(['replaceUrl', 'mount'])
    expect(target.dataset[PAGE_MOUNT_STATE_KEY]).toBe('shell-ready')
  })
})

describe('the page bootstrap under a shell that named no screen', () => {
  it('refuses instead of mounting the tree at a path no route claims', () => {
    const channel = installChannel()
    const target = createTarget()
    const page = bootstrap(target)

    const { route: _route, ...withoutRoute } = INIT
    channel.deliver(withoutRoute)

    expect(page.order).toEqual(['refuse'])
    expect(target.dataset[PAGE_MOUNT_STATE_KEY]).toBe('shell-too-old')
    // Still stamped: the build it could not open is the fact worth reading off the document.
    expect(target.dataset[PAGE_BUILD_ID_KEY]).toBe('build-a')
  })

  it('does not go on waiting for a second init that says more', () => {
    const channel = installChannel()
    const page = bootstrap(createTarget())

    const { route: _route, ...withoutRoute } = INIT
    channel.deliver(withoutRoute)
    channel.deliver(INIT)

    expect(page.order).toEqual(['refuse'])
  })
})

describe('the page bootstrap outside the shell', () => {
  it('builds no client when nothing installed a channel', () => {
    expect(createShellPageClient()).toBeNull()
  })

  it('says so and does nothing to the document, because no init is ever coming', () => {
    const target = createTarget()
    const page = bootstrap(target)

    expect(page.order).toEqual([])
    expect(target.dataset[PAGE_MOUNT_STATE_KEY]).toBe('unbridged')
    expect(target.dataset[PAGE_SESSION_ID_KEY]).toBeUndefined()
  })
})

describe('the url the page writes for a route', () => {
  it('is the pathname alone when the screen was opened with no params', () => {
    expect(shellRouteHref({ pathname: '/h/host-a' })).toBe('/h/host-a')
    expect(shellRouteHref({ pathname: '/h/host-a', params: {} })).toBe('/h/host-a')
  })

  it('escapes what a param holds rather than pasting it into a path', () => {
    expect(shellRouteHref({ pathname: '/h/a', params: { name: 'a&b=c?d#e' } })).toBe(
      '/h/a?name=a%26b%3Dc%3Fd%23e'
    )
  })
})

describe('the mount state attribute', () => {
  it('records the last state reached, so the entry can say its script ran', () => {
    const target = createTarget()
    stampPageMountState(target, 'started')
    expect(target.dataset[PAGE_MOUNT_STATE_KEY]).toBe('started')
    stampPageMountState(target, 'mounted')
    expect(target.dataset[PAGE_MOUNT_STATE_KEY]).toBe('mounted')
  })
})
