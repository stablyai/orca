// Push host B over A, then pop: A must regain area ownership without a duplicate native sidebar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())
const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))
const stack = await vi.hoisted(async () => {
  const React = await import('react')
  const hosts: string[] = ['host-a']
  return {
    hosts,
    Focused: React.createContext(true),
    HostSidebar: function HostSidebar(): null {
      return null
    }
  }
})

vi.mock('react-native', () => ({
  ...mocks['react-native'](),
  PanResponder: { create: () => ({ panHandlers: {} }) },
  useWindowDimensions: () => ({ width: 1180, height: 820 })
}))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    ...mocks['expo-router'](),
    useGlobalSearchParams: () => ({ hostId: stack.hosts.at(-1) }),
    // Model native stack focus: rerun only for the top screen when it returns.
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = React.useContext(stack.Focused)
      React.useEffect(() => (focused ? effect() : undefined), [focused, effect])
    }
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
  useMobileWebShellSession: (args: { routePathname: string }) => ({
    ...mocks['./use-mobile-web-shell-session']().useMobileWebShellSession(),
    ownsHostArea: /^\/h\/[^/]+$/.test(args.routePathname)
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
vi.mock('../host-screen/HostScreen', () => ({ HostScreen: stack.HostSidebar }))
vi.mock('../navigation/host-stack', async () => {
  const { MobileWebShellScreen } = await import('./MobileWebShellScreen')
  return {
    HostStack: () =>
      stack.hosts.map((hostId, index) => (
        <stack.Focused.Provider key={hostId} value={index === stack.hosts.length - 1}>
          <MobileWebShellScreen hostId={hostId} route={{ pathname: `/h/${hostId}` }} />
        </stack.Focused.Provider>
      ))
  }
})

import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import HostGroupLayout from '../../app/h/_layout'

const mounted: { tree: ReactTestRenderer | null } = { tree: null }

async function show(hosts: string[]): Promise<number> {
  stack.hosts = hosts
  dependencies.pathname = `/h/${hosts.at(-1) ?? ''}`
  await act(async () => {
    if (mounted.tree === null) {
      mounted.tree = create(<HostGroupLayout />)
    } else {
      mounted.tree.update(<HostGroupLayout />)
    }
  })
  await act(async () => {})
  return mounted.tree?.root.findAllByType(stack.HostSidebar).length ?? 0
}

beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
  dependencies.state = harness.readyState('session-1')
  mounted.tree = null
})

afterEach(() => {
  act(() => mounted.tree?.unmount())
})

describe('two hosts whose pages own the host area', () => {
  it('draws no native sidebar beside either, through a push and the pop back', async () => {
    expect(await show(['host-a'])).toBe(0)
    expect(await show(['host-a', 'host-b'])).toBe(0)
    expect(await show(['host-a'])).toBe(0)
  })
})
