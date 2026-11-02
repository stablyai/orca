// Count sidebars from the real layout and reducer decisions; model released layouts/pages separately because both rendered whenever wide before canOwnHostArea.
import { useCallback, useContext } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

type Renderer = 'native' | 'page' | 'shipped-shell' | 'old-page'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())
const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))

const { HostSidebar } = vi.hoisted(() => ({
  HostSidebar: function HostSidebar(): null {
    return null
  }
}))

const env = vi.hoisted(
  (): {
    width: number
    height: number
    pathname: string
    renderer: Renderer
    hostSession: MobileWebShellSession | null
    reports: boolean[]
  } => ({
    width: 390,
    height: 844,
    pathname: '/h/host-1',
    renderer: 'native',
    hostSession: null,
    reports: []
  })
)

vi.mock('react-native', () => ({
  ...mocks['react-native'](),
  Platform: {
    get OS() {
      return env.renderer === 'page' || env.renderer === 'old-page' ? 'web' : 'ios'
    }
  },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  useWindowDimensions: () => ({ width: env.width, height: env.height })
}))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    ...mocks['expo-router'](),
    useGlobalSearchParams: () => ({ hostId: 'host-1' }),
    usePathname: () => env.pathname,
    useFocusEffect: (effect: () => undefined | (() => void)) => React.useEffect(effect, [effect])
  }
})
vi.mock('expo-clipboard', mocks['expo-clipboard'])
vi.mock('expo-haptics', mocks['expo-haptics'])
vi.mock('expo-document-picker', mocks['expo-document-picker'])
vi.mock('@orca/expo-two-way-audio', mocks['@orca/expo-two-way-audio'])
vi.mock('expo-keep-awake', mocks['expo-keep-awake'])
vi.mock('expo-image-picker', mocks['expo-image-picker'])
vi.mock('expo-file-system', mocks['expo-file-system'])
vi.mock('lucide-react-native', mocks['lucide-react-native'])
vi.mock('react-native-safe-area-context', mocks['react-native-safe-area-context'])
vi.mock('../../modules/orca-mobile-web-shell/src', mocks['../../modules/orca-mobile-web-shell/src'])
vi.mock('../app-update/use-wall-app-update', mocks['../app-update/use-wall-app-update'])
vi.mock('../transport/host-client-hooks', mocks['../transport/host-client-hooks'])
vi.mock('./use-page-host-snapshot', mocks['./use-page-host-snapshot'])
vi.mock('./use-mobile-web-shell-session', () => ({
  useMobileWebShellSession: () => ({
    ...mocks['./use-mobile-web-shell-session']().useMobileWebShellSession(),
    ...(env.hostSession === null
      ? {}
      : { state: env.hostSession.state, ownsHostArea: env.hostSession.ownsHostArea })
  })
}))
vi.mock('../theme/mobile-theme', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  colors: {}
}))
vi.mock('../storage/preferences', () => ({
  HOST_SIDEBAR_DEFAULT_WIDTH: 320,
  HOST_SIDEBAR_MAX_WIDTH: 480,
  HOST_SIDEBAR_MIN_WIDTH: 240,
  loadHostSidebarWidth: async () => 320,
  saveHostSidebarWidth: async () => {}
}))
vi.mock('../components/HostProtocolGate', () => ({
  HostProtocolGate: ({ children }: { children: unknown }) => children
}))
vi.mock('../host-screen/HostScreen', () => ({ HostScreen: HostSidebar }))
vi.mock('../navigation/host-stack', async () => {
  const serving = await import('./host-area-serving')
  const { MobileWebShellScreen } = await import('./MobileWebShellScreen')
  return {
    HostStack: function HostStack() {
      const report = useContext(serving.HostAreaServingContext)
      const recorded = useCallback(
        (served: boolean) => {
          env.reports.push(served)
          report(served)
        },
        [report]
      )
      return (
        <serving.HostAreaServingContext.Provider value={recorded}>
          {env.hostSession === null ? null : (
            <MobileWebShellScreen hostId="host-1" route={{ pathname: HOST }} />
          )}
        </serving.HostAreaServingContext.Provider>
      )
    }
  }
})
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))
vi.mock('./page-owns-host-area', async () => {
  const native =
    await vi.importActual<typeof import('./page-owns-host-area')>('./page-owns-host-area')
  const page = await vi.importActual<typeof import('./page-owns-host-area.web')>(
    './page-owns-host-area.web'
  )
  return {
    usePageOwnsHostArea: (): boolean => {
      switch (env.renderer) {
        case 'native':
        case 'shipped-shell':
          return native.usePageOwnsHostArea()
        case 'page':
          return page.usePageOwnsHostArea()
        case 'old-page':
          return true
      }
    }
  }
})

import HostGroupLayout from '../../app/h/_layout'
import { RpcClientProvider } from '../transport/client-context.web'
import { createFakeBridgePortPair } from './bridge/bridge-port-pair-test-harness'
import {
  BUNDLE_REFUSED,
  createMobileWebShellSession,
  gates,
  MANIFEST_WIRE,
  manifestFacts,
  run
} from './mobile-web-shell-session-test-fixtures'
import type { MobileWebShellSession } from './mobile-web-shell-session-contract'
import type { MobileWebPageRoute } from './page-route-policy'

const IPAD = { width: 1180, height: 820 }
const PHONE = { width: 390, height: 844 }
const SIDEBAR = 320
const HOST = '/h/host-1'
const DETAIL = '/h/host-1/session/wt-1'

type Shell = 'shipped' | 'new'
type Page = 'none' | 'undeclared' | 'declared'

function pageRoutes(page: Page): MobileWebPageRoute[] | null {
  if (page === 'none') {
    return null
  }
  return [
    {
      pathname: '/h/[hostId]',
      grants: ['navigate'],
      ...(page === 'declared' ? { canOwnHostArea: true, canOwnHostAreaAcrossLayouts: true } : {})
    },
    { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate'] }
  ]
}

function sessionFor(page: Page, pathname: string, wide: boolean) {
  const routes = pageRoutes(page)
  const opened = run(
    createMobileWebShellSession(pathname),
    { type: 'layout-changed', wide },
    { type: 'gates-changed', gates: routes === null ? gates({ hostCapabilities: [] }) : gates() }
  ).session
  if (routes === null) {
    return opened
  }
  return run(
    opened,
    { type: 'cache-read', generation: null },
    { type: 'manifest-read', manifest: manifestFacts({ ...MANIFEST_WIRE, routes }) },
    { type: 'download-staged' }
  ).session
}

function served(page: Page, pathname: string, wide: boolean): boolean {
  return sessionFor(page, pathname, wide).state.kind === 'activating'
}

async function sidebarsIn(
  renderer: Renderer,
  viewport: { width: number; height: number },
  options: { pathname?: string; ownsHostArea?: boolean; hostSession?: MobileWebShellSession } = {}
): Promise<number> {
  env.renderer = renderer
  env.width = viewport.width
  env.height = viewport.height
  env.pathname = options.pathname ?? HOST
  env.hostSession = options.hostSession ?? null
  const mounted: { tree: ReactTestRenderer | null } = { tree: null }
  if (renderer === 'page' || renderer === 'old-page') {
    const pair = createFakeBridgePortPair({
      route: { pathname: env.pathname },
      ...(options.ownsHostArea === undefined ? {} : { ownsHostArea: options.ownsHostArea })
    })
    await pair.flush()
    await act(async () => {
      mounted.tree = create(
        <RpcClientProvider client={pair.client}>
          <HostGroupLayout />
        </RpcClientProvider>
      )
    })
  } else {
    await act(async () => {
      mounted.tree = create(<HostGroupLayout />)
    })
  }
  await act(async () => {})
  const count = mounted.tree?.root.findAllByType(HostSidebar).length ?? 0
  act(() => mounted.tree?.unmount())
  return count
}

// hostAreaBeneath models a detail pushed over the host page; without it, the detail was deep-linked.
async function countSidebars(
  shell: Shell,
  page: Page,
  wide: boolean,
  at: string = HOST,
  hostAreaBeneath = at === HOST
) {
  const window = wide ? IPAD : PHONE
  const pageCode: Renderer = page === 'declared' ? 'page' : 'old-page'
  if (shell === 'shipped') {
    const native = await sidebarsIn('shipped-shell', window, { pathname: at })
    const opens = page !== 'none' && !(wide && at === HOST) && served(page, at, false)
    const pane = wide ? { ...window, width: window.width - SIDEBAR } : window
    return { native, pages: opens ? await sidebarsIn(pageCode, pane, { pathname: at }) : 0 }
  }
  const native = await sidebarsIn('native', window, {
    pathname: at,
    ...(hostAreaBeneath ? { hostSession: sessionFor(page, HOST, wide) } : {})
  })
  let pages = 0
  const session = sessionFor(page, at, wide)
  if (session.state.kind === 'activating') {
    const pane = wide && native > 0 ? { ...window, width: window.width - SIDEBAR } : window
    pages = await sidebarsIn(pageCode, pane, { pathname: at, ownsHostArea: session.ownsHostArea })
  }
  return { native, pages }
}

describe('host sidebars on screen, per shell, page and width, on the host route', () => {
  const rows: [Shell, Page, boolean, { native: number; pages: number }][] = [
    ['shipped', 'none', false, { native: 0, pages: 0 }],
    ['shipped', 'undeclared', false, { native: 0, pages: 0 }],
    ['shipped', 'declared', false, { native: 0, pages: 0 }],
    ['new', 'none', false, { native: 0, pages: 0 }],
    ['new', 'undeclared', false, { native: 0, pages: 0 }],
    ['new', 'declared', false, { native: 0, pages: 0 }],
    ['shipped', 'none', true, { native: 1, pages: 0 }],
    ['shipped', 'undeclared', true, { native: 1, pages: 0 }],
    ['shipped', 'declared', true, { native: 1, pages: 0 }],
    ['new', 'none', true, { native: 1, pages: 0 }],
    ['new', 'undeclared', true, { native: 1, pages: 0 }],
    ['new', 'declared', true, { native: 0, pages: 1 }]
  ]

  it.each(rows)('%s shell, %s page, wide=%s', async (shell, page, wide, expected) => {
    expect(await countSidebars(shell, page, wide)).toEqual(expected)
  })
})

describe('host sidebars on a wide detail route', () => {
  const rows: [string, Shell, Page, boolean, { native: number; pages: number }][] = [
    // Both released versions are outside this tree; retain their pairing as a compatibility fixture.
    ['old app opening a detail', 'shipped', 'undeclared', false, { native: 1, pages: 1 }],
    ['old app opening a detail', 'shipped', 'declared', false, { native: 1, pages: 0 }],
    ['deep link or notification', 'new', 'none', false, { native: 1, pages: 0 }],
    ['deep link or notification', 'new', 'undeclared', false, { native: 1, pages: 0 }],
    ['deep link or notification', 'new', 'declared', false, { native: 1, pages: 0 }],
    ['narrow to wide with a detail pushed', 'new', 'declared', false, { native: 1, pages: 0 }],
    ['handoff to a native screen', 'new', 'declared', true, { native: 1, pages: 0 }],
    ['handoff to a native screen', 'new', 'undeclared', true, { native: 1, pages: 0 }]
  ]

  it.each(rows)('%s: %s shell, %s page', async (_case, shell, page, beneath, expected) => {
    expect(await countSidebars(shell, page, true, DETAIL, beneath)).toEqual(expected)
  })
})

describe('the native sidebar beside a declaring page on its way in', () => {
  const declared = pageRoutes('declared') ?? []
  const checking = run(createMobileWebShellSession(HOST, true), {
    type: 'gates-changed',
    gates: gates()
  }).session
  const fetching = run(
    checking,
    { type: 'cache-read', generation: null },
    { type: 'manifest-read', manifest: manifestFacts({ ...MANIFEST_WIRE, routes: declared }) }
  ).session
  const failed = run(fetching, { type: 'download-failed', cause: BUNDLE_REFUSED }).session
  const rechecking = run(failed, { type: 'retry-pressed' }).session
  // Keep native sidebar until ownership is declared, including failures; retry must show it while checking again.
  const rows: [string, MobileWebShellSession, number][] = [
    ['checking', checking, 1],
    ['fetching', fetching, 0],
    ['activating', run(fetching, { type: 'download-staged' }).session, 0],
    ['failed', failed, 0],
    ['checking again', rechecking, 1]
  ]

  it.each(rows)('%s', async (_state, hostSession, expected) => {
    expect(hostSession.state.kind).toBe(_state === 'checking again' ? 'checking' : _state)
    expect(await sidebarsIn('native', IPAD, { hostSession })).toBe(expected)
  })
})

describe('the page sidebar rule', () => {
  it('draws no sidebar in a wide viewport without the init fact', async () => {
    expect(await sidebarsIn('page', IPAD)).toBe(0)
    expect(await sidebarsIn('page', IPAD, { ownsHostArea: false })).toBe(0)
    expect(await sidebarsIn('page', { width: 1366 - SIDEBAR, height: 1024 })).toBe(0)
  })

  it('draws one only when the shell gave it the host area, and only when wide', async () => {
    expect(await sidebarsIn('page', IPAD, { ownsHostArea: true })).toBe(1)
    expect(await sidebarsIn('page', PHONE, { ownsHostArea: true })).toBe(0)
  })
})

describe('a phone', () => {
  it('reports host ownership without drawing a sidebar on a narrow viewport', async () => {
    const hostSession = sessionFor('declared', HOST, false)
    expect(hostSession.state.kind).toBe('activating')
    env.reports.length = 0
    expect(await sidebarsIn('native', PHONE, { hostSession })).toBe(0)
    expect(env.reports).toEqual([true, false])
  })
})
