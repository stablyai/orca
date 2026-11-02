import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { RpcClientProvider } from '../transport/client-context.web'
import type { MobileSessionController } from '../session/use-mobile-session-controller'
import { MobileSessionHeader } from '../session/MobileSessionHeader'
import HostGroupLayout from '../../app/h/_layout'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Platform: {
    OS: 'web',
    select: (values: Record<string, unknown>) => values.web ?? values.default
  },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  Folder: 'Folder',
  File: 'File',
  FileText: 'FileText',
  GitBranch: 'GitBranch',
  Globe: 'Globe',
  MoreHorizontal: 'MoreHorizontal',
  PanelLeftOpen: 'PanelLeftOpen',
  Plus: 'Plus',
  Terminal: 'Terminal'
}))
vi.mock('expo-router', () => ({
  useGlobalSearchParams: () => ({ hostId: 'host' }),
  usePathname: () => '/h/host/session/workspace'
}))
vi.mock('./responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: true, width: 1024 })
}))
vi.mock('../storage/preferences', () => ({
  HOST_SIDEBAR_DEFAULT_WIDTH: 320,
  HOST_SIDEBAR_MIN_WIDTH: 240,
  HOST_SIDEBAR_MAX_WIDTH: 480,
  loadHostSidebarWidth: async () => 320,
  saveHostSidebarWidth: async () => {}
}))
vi.mock('../components/HostProtocolGate', () => ({
  HostProtocolGate: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../host-screen/HostScreen', () => ({
  HostScreen: ({ onHideSidebar }: { onHideSidebar: () => void }) =>
    createElement('Pressable', {
      accessibilityLabel: 'Hide sidebar',
      onPress: onHideSidebar
    })
}))
vi.mock('../navigation/host-stack', () => ({
  HostStack: () => createElement(MobileSessionHeader, { controller: headerController() })
}))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: () => {} }))
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: vi.fn(),
  useForceReconnect: vi.fn(),
  useForgetHostClient: vi.fn(),
  useHostClient: vi.fn(),
  usePrimeHosts: vi.fn(),
  useRefreshHostClient: vi.fn()
}))
vi.mock('../transport/client-context', async () => import('../transport/client-context.web'))
vi.mock(
  '../mobile-web-shell/page-owns-host-area',
  async () => import('../mobile-web-shell/page-owns-host-area.web')
)

function headerController(): MobileSessionController {
  const controller: Partial<MobileSessionController> = {
    hostId: 'host',
    isFolderWorkspaceRoute: true,
    isFloatingWorkspaceRoute: true,
    connState: 'connected',
    worktreeName: 'Workspace',
    visibleTabs: [],
    showConnectionRetry: false,
    terminalSummary: 'Claude',
    showHeaderMoreButton: false,
    requestLeaveSession: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This header fixture supplies every rendered field; no tab or panel actions are exercised.
  return controller as MobileSessionController
}

describe('host sidebar reveal in the session header', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function tree(): ReactTestRenderer {
    if (!renderer) {
      throw new Error('Layout was not mounted')
    }
    return renderer
  }

  async function mountPage(ownsHostArea: boolean): Promise<void> {
    const pair = createFakeBridgePortPair({
      route: { pathname: '/h/host/session/workspace' },
      ownsHostArea
    })
    await pair.flush()
    const client = pair.client
    await act(async () => {
      renderer = create(
        <RpcClientProvider client={client}>
          <HostGroupLayout />
        </RpcClientProvider>
      )
    })
  }

  function buttons(label: string) {
    return tree().root.findAllByProps({ accessibilityLabel: label })
  }

  it('offers no reveal in a page beside the native sidebar, which it does not draw', async () => {
    await mountPage(false)

    expect(buttons('Hide sidebar')).toHaveLength(0)
    expect(buttons('Show sidebar')).toHaveLength(0)
    expect(buttons('Back to worktrees')).toHaveLength(1)
  })

  it('reveals the sidebar a page draws when it owns the host area', async () => {
    await mountPage(true)
    expect(buttons('Show sidebar')).toHaveLength(0)
    await act(async () => buttons('Hide sidebar')[0]?.props.onPress())

    expect(buttons('Hide sidebar')).toHaveLength(0)
    expect(buttons('Show sidebar')).toHaveLength(1)
    await act(async () => buttons('Show sidebar')[0]?.props.onPress())
    expect(buttons('Hide sidebar')).toHaveLength(1)
    expect(buttons('Show sidebar')).toHaveLength(0)
  })
})
