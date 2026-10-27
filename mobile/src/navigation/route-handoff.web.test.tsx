import type { ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
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
  navigate: vi.fn(),
  dismissTo: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  setParams: vi.fn(),
  canGoBack: vi.fn(() => false)
}))

vi.mock('expo-router', () => ({ useRouter: () => router, usePathname: () => '/' }))
// Stub re-exported hooks to avoid importing Expo; these tests call none of them.
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

function backs(posted: readonly string[]): unknown[] {
  return posted
    .map((json) => JSON.parse(json))
    .filter((frame: { name?: string }) => frame.name === BRIDGE_NAVIGATE_BACK_NOTIFY)
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
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-b?from=list', undefined)
  })
})

// Assert the explicit undefined options argument too; wrappers forward both arguments and Expo treats it as absent.
describe('a route the page does render', () => {
  it('stays in this document rather than re-entering the shell for it', () => {
    const { posted, handoff } = mount(INIT)
    handoff.push('/h/host-b')
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-b', undefined)
  })

  it('replaces locally, which is a history entry the native stack never had', () => {
    const { handoff } = mount(INIT)
    handoff.replace('/h/host-b')
    expect(router.replace).toHaveBeenCalledWith('/h/host-b', undefined)
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

  it('names the reason once per hook instance, not once per tap', () => {
    const { handoff } = mount({ ...INIT, grants: { ...INIT.grants, native: [] }, pageRoutes: [] })
    handoff.push('/h/host-a/session/wt-1')
    handoff.push('/h/host-a/session/wt-2')
    handoff.replace('/h/host-a/tasks')
    expect(warned).toHaveLength(1)
    expect(JSON.stringify(warned[0])).toContain('shell-refused')
  })
})

// Validate hrefs before posting: notifyNavigate reports send handoff, not whether the shell accepted its target.
describe('a target the shell would refuse', () => {
  it('resolves the object form the Connection-log link builds, rather than posting [object Object]', () => {
    const { posted, handoff } = mount(INIT)
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

  it('names a malformed href separately from a shell that would not take it', () => {
    const { handoff } = mount(INIT)
    handoff.push('/h/host-a/tasks#top')
    expect(JSON.stringify(warned[0])).toContain('malformed-href')
  })
})

// The initial document has one history entry; Back must ask the native stack unless the page has pushed its own screens.
describe('a back this document cannot serve', () => {
  it('hands the pop to the shell rather than going nowhere', () => {
    const { posted, handoff } = mount(INIT)
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
    const { posted, handoff, failPosts } = mount(INIT)
    failPosts()
    expect(() => handoff.back()).not.toThrow()
    expect(backs(posted)).toEqual([])
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warned)).toContain('send-failed')
  })
})

// Wrap every href-taking router member; spreading navigate/prefetch untouched would bypass page-route policy.
describe('every member that takes a target', () => {
  it('is replaced rather than handed through, all of them', () => {
    const options = { withAnchor: false }
    for (const member of ['push', 'replace', 'navigate', 'dismissTo'] as const) {
      router[member].mockClear()
      const { posted, handoff } = mount(INIT)
      handoff[member]('/h/host-b', options)
      expect(router[member], member).toHaveBeenCalledExactlyOnceWith('/h/host-b', options)
      router[member].mockClear()
      handoff[member]('/h/host-a/session/wt-1')
      expect(navigations(posted), member).toEqual([
        {
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'notify',
          name: 'navigate',
          href: '/h/host-a/session/wt-1'
        }
      ])
      handoff[member]('/h/host-a/tasks#top')
      expect(navigations(posted), member).toHaveLength(1)
      expect(router[member], member).not.toHaveBeenCalled()
    }
  })

  it('leaves a member that takes no target exactly as the router had it', () => {
    const { handoff } = mount(INIT)
    expect(handoff.setParams).toBe(router.setParams)
  })
})

describe('navigate, which is a push that may collapse onto an existing screen', () => {
  it('goes to the shell for a route this document does not render', () => {
    const { posted, handoff } = mount(INIT)
    handoff.navigate('/h/host-a/session/wt-1')
    expect(navigations(posted)).toEqual([
      {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'navigate',
        href: '/h/host-a/session/wt-1'
      }
    ])
    expect(router.navigate).not.toHaveBeenCalled()
  })

  it('stays in this document for a route it does render', () => {
    const { posted, handoff } = mount(INIT)
    handoff.navigate('/h/host-b')
    expect(navigations(posted)).toEqual([])
    expect(router.navigate).toHaveBeenCalledWith('/h/host-b', undefined)
  })

  it('refuses rather than opening a target the shell would not take', () => {
    const { posted, handoff } = mount({ ...INIT, grants: { ...INIT.grants, native: [] } })
    handoff.navigate('/h/host-a/session/wt-1')
    expect(navigations(posted)).toEqual([])
    expect(router.navigate).not.toHaveBeenCalled()
  })
})

// Never hand prefetch to native navigate: a background optimization must not open a screen.
describe('prefetch', () => {
  it('warms a route this document renders, which is what the chunk split makes worth doing', () => {
    const { handoff } = mount(INIT)
    handoff.prefetch('/h/host-b')
    expect(router.prefetch).toHaveBeenCalledWith('/h/host-b')
  })

  it('never posts a navigate for one it does not, and does not open it locally either', () => {
    const { posted, handoff } = mount(INIT)
    handoff.prefetch('/h/host-a/session/wt-1')
    expect(navigations(posted)).toEqual([])
    expect(router.prefetch).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('says nothing about a target it dropped, because a warm-up that did not happen is not news', () => {
    const { handoff } = mount(INIT)
    handoff.prefetch('/h/host-a/session/wt-1')
    expect(warned).toEqual([])
  })
})

// Preserve options for every local target-taker so future callers cannot silently lose router behavior.
describe('navigation options', () => {
  const options = { withAnchor: false }

  it('reach the router on the branch this document serves', () => {
    const { handoff } = mount(INIT)
    handoff.push('/h/host-b', options)
    expect(router.push).toHaveBeenCalledWith('/h/host-b', options)
  })

  it('reach it from every target-taker that has a local branch', () => {
    const { handoff } = mount(INIT)
    handoff.replace('/h/host-b', options)
    handoff.navigate('/h/host-b', options)
    handoff.dismissTo('/h/host-b', options)
    expect(router.replace).toHaveBeenCalledWith('/h/host-b', options)
    expect(router.navigate).toHaveBeenCalledWith('/h/host-b', options)
    expect(router.dismissTo).toHaveBeenCalledWith('/h/host-b', options)
  })

  it('do not cross to the shell, which the notify has no room for', () => {
    const { posted, handoff } = mount(INIT)
    handoff.push('/h/host-a/session/wt-1', options)
    // Bridge navigation carries href only; native stack policy owns options after handoff.
    expect(navigations(posted)).toEqual([
      {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'navigate',
        href: '/h/host-a/session/wt-1'
      }
    ])
  })
})

// Local targets run under the opener’s grants; hand off any target needing more so its own session receives the required capabilities.
describe('an in-page hop the session cannot cover', () => {
  const TASKS = '/h/host-a/tasks'
  const PAIRS = [
    { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'haptics'] },
    {
      pathname: '/h/[hostId]/tasks',
      grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
    }
  ]
  const withPairs = (native: string[]) => ({
    ...INIT,
    grants: { ...INIT.grants, native },
    pageRoutes: ['/h/[hostId]', '/h/[hostId]/tasks'],
    pageRouteGrants: PAIRS
  })

  it('goes to the shell when the target needs a grant this session lacks', () => {
    const { posted, handoff } = mount(withPairs(['navigate', 'storage', 'haptics']))
    handoff.push(TASKS)
    expect(navigations(posted)).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'navigate', href: TASKS }
    ])
    expect(router.push).not.toHaveBeenCalled()
  })

  it('stays in this document when the session already covers the target', () => {
    const { posted, handoff } = mount(
      withPairs(['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'])
    )
    handoff.push(TASKS)
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith(TASKS, undefined)
  })

  it("hands off when the session lacks any one of the target's grants, not the clipboard alone", () => {
    // Withhold externalLink alone too so a check covering only native verbs cannot pass.
    const { posted, handoff } = mount(
      withPairs(['navigate', 'storage', 'haptics', 'native.clipboard.write'])
    )
    handoff.push(TASKS)
    expect(navigations(posted)).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'navigate', href: TASKS }
    ])
    expect(router.push).not.toHaveBeenCalled()
  })

  it('keeps a hop whose target declares a subset, which is C3.1 without its pairwise pin', () => {
    const { posted, handoff } = mount({
      ...INIT,
      grants: { ...INIT.grants, native: ['navigate', 'storage', 'externalLink', 'haptics'] },
      pageRoutes: ['/h/[hostId]/files/[worktreeId]', '/h/[hostId]/files/preview/[worktreeId]'],
      pageRouteGrants: [
        { pathname: '/h/[hostId]/files/[worktreeId]', grants: ['navigate', 'storage', 'haptics'] },
        { pathname: '/h/[hostId]/files/preview/[worktreeId]', grants: ['navigate', 'haptics'] }
      ]
    })
    handoff.push('/h/host-a/files/preview/wt-1')
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-a/files/preview/wt-1', undefined)
  })

  it('leaves a non-page route exactly as it was', () => {
    const { posted, handoff } = mount(withPairs(['navigate', 'storage', 'haptics']))
    handoff.push('/h/host-a/session/wt-1')
    expect(navigations(posted)).toHaveLength(1)
    expect(router.push).not.toHaveBeenCalled()
  })

  it('keeps the old rule when the shell named no grants, so an older shell is unchanged', () => {
    // Absent pairs preserve older-shell behavior; absence does not declare an empty grant list.
    const { posted, handoff } = mount({
      ...INIT,
      grants: { ...INIT.grants, native: ['navigate', 'storage', 'haptics'] },
      pageRoutes: ['/h/[hostId]', '/h/[hostId]/tasks']
    })
    handoff.push(TASKS)
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith(TASKS, undefined)
  })

  it('hands off a target the shell lists with no entry of its own', () => {
    // Listed but unpaired targets cannot prove grant coverage and must hand off.
    const { posted, handoff } = mount({
      ...withPairs(['navigate', 'storage', 'haptics']),
      pageRouteGrants: [{ pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'haptics'] }]
    })
    handoff.push(TASKS)
    expect(navigations(posted)).toHaveLength(1)
    expect(router.push).not.toHaveBeenCalled()
  })
})
