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
vi.mock('../device-store/device-store', mocks['../device-store/device-store'])
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
import './mobile-web-shell-session-test-fixtures'
import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

const IPAD = { width: 1180, height: 820 }
const PHONE = { width: 390, height: 844 }

const HOST = '/h/host-1'

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

describe('the page sidebar rule', () => {
  it('draws one only when the shell gave it the host area, and only when wide', async () => {
    expect(await sidebarsIn('page', IPAD, { ownsHostArea: true })).toBe(1)
    expect(await sidebarsIn('page', PHONE, { ownsHostArea: true })).toBe(0)
  })
})
