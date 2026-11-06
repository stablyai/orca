import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMobileProject } from './mobile-project-navigation'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'
import type { Worktree } from '../worktree/workspace-list-types'
import type { HostScreenController } from './use-host-screen-controller'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  ScrollView: 'ScrollView',
  RefreshControl: 'RefreshControl',
  StyleSheet: { create: <T,>(s: T) => s }
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  ChevronLeft: 'ChevronLeft',
  Ellipsis: 'Ellipsis',
  Search: 'Search'
}))
vi.mock('../components/AuthFailedBanner', () => ({ AuthFailedBanner: 'AuthFailedBanner' }))
vi.mock('../components/StatusDot', () => ({ StatusDot: 'StatusDot' }))
vi.mock('../components/HostRouteNoticeBanner', () => ({
  HostRouteNoticeBanner: 'HostRouteNoticeBanner'
}))
vi.mock('../theme/use-mobile-color-scheme', () => ({
  useMobileColorScheme: () => 'dark'
}))
vi.mock('./use-mobile-project-sessions', () => ({
  useMobileProjectSessions: () => new Map(),
  projectSnapshotKey: (host: string, id: string) => JSON.stringify([host, id])
}))
import {
  buildRequestStreamUnsubscribe,
  buildStreamUnsubscribe
} from '../transport/rpc-client-terminal-subscription'
import { MobileProjectHeader } from './MobileProjectHeader'
import { MobileProjectList, MobileProjectRow } from './MobileProjectList'

const workspace: Worktree = {
  worktreeId: 'repo::/a',
  repoId: 'repo',
  repo: 'Frontend_Auth',
  displayName: 'Frontend_Auth',
  hostContextLabel: 'Mac mini',
  path: '/a',
  branch: 'main',
  liveTerminalCount: 0,
  hasAttachedPty: false,
  unread: false,
  isPinned: false,
  linkedPR: null
}
let renderer: ReactTestRenderer | undefined
afterEach(() => act(() => renderer?.unmount()))
function render(titles: string[]) {
  const onOpen = vi.fn()
  const project = buildMobileProject(
    workspace,
    {
      worktree: workspace.worktreeId,
      tabs: titles.map((title, i) => ({
        type: 'agent-session',
        id: `agent-session:chat${i}`,
        sessionId: `chat${i}`,
        title,
        agent: 'codex'
      }))
    },
    true
  )
  act(() => {
    renderer = create(<MobileProjectRow project={project} onOpen={onOpen} />)
  })
  return { onOpen, project, root: renderer!.root }
}
describe('mobile project row navigation', () => {
  it('opens the owner without expanding helpers and exposes screen-reader hints', () => {
    const { root, onOpen, project } = render(['Frontend_Auth_Worker', 'Frontend_Auth_Owner'])
    const rowButton = root.findByProps({ accessibilityLabel: 'Frontend_Auth' })
    expect(rowButton.props.accessibilityHint).toContain('Mac mini')
    act(() => rowButton.props.onPress())
    expect(onOpen).toHaveBeenCalledWith(workspace, project.sessions.find((s) => s.owner)?.paneKey)
    expect(root.findAllByProps({ accessibilityLabel: 'Frontend_Auth_Worker' })).toHaveLength(0)
  })
  it('expands multiple owners then navigates to the chosen conversation', () => {
    const { root, onOpen, project } = render(['Frontend_Auth_Owner', 'Frontend_Billing_Owner'])
    act(() => root.findByProps({ accessibilityLabel: 'Frontend_Auth' }).props.onPress())
    expect(onOpen).not.toHaveBeenCalled()
    const billingButton = root.findByProps({ accessibilityLabel: 'Frontend_Billing_Owner' })
    expect(billingButton.props.accessibilityHint).toContain('codex')
    act(() => billingButton.props.onPress())
    expect(onOpen).toHaveBeenCalledWith(workspace, project.sessions[1]?.paneKey)
  })
  it('keeps archived conversations hidden until history is requested', () => {
    const { root } = render(['Frontend_Auth_Owner', 'Frontend_Auth_Archived'])
    act(() => root.findByProps({ accessibilityLabel: 'Auth sessions' }).props.onPress())
    expect(root.findAllByProps({ accessibilityLabel: 'Frontend_Auth_Archived' })).toHaveLength(0)
    act(() => root.findByProps({ accessibilityLabel: 'Auth history' }).props.onPress())
    expect(root.findAllByProps({ accessibilityLabel: 'Frontend_Auth_Archived' })).toHaveLength(1)
  })
  it('filters by bottom-bar search queries, dismisses connection notices, and preserves pairing recovery', () => {
    const baseController = (overrides: Partial<HostScreenController> = {}) =>
      ({
        hostId: 'host-1',
        collapsedGroups: new Set(),
        displayWorktrees: [workspace],
        connState: 'disconnected',
        relayRecovery: { pairingRejected: false },
        forceReconnectHost: vi.fn(),
        router: { push: vi.fn() },
        insets: { bottom: 0, top: 0, left: 0, right: 0 },
        catalog: { refreshing: false, onRefresh: vi.fn() },
        settings: { isCollapsed: () => false, toggleCollapsed: vi.fn() },
        actions: { openWorktreeSession: vi.fn(), openCreateWorkspaceModal: vi.fn() },
        routeNotice: '',
        noticeParam: undefined,
        setDismissedNotice: vi.fn(),
        isReadOnly: false,
        state: {
          view: INITIAL_MOBILE_VIEW,
          repoHostIdByRepoId: {},
          search: '',
          setSearch: vi.fn(),
          actionError: '',
          setActionError: vi.fn(),
          serverNotice: null,
          setServerNotice: vi.fn(),
          setConfirmRemoveHost: vi.fn()
        },
        ...overrides
      }) as unknown as HostScreenController

    act(() => {
      renderer = create(<MobileProjectList controller={baseController()} />)
    })
    expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Frontend_Auth' })).toHaveLength(1)
    const notices = renderer!.root.findAllByType('HostRouteNoticeBanner' as never)
    expect(notices).toHaveLength(1)
    act(() => notices[0]!.props.onDismiss())
    expect(renderer!.root.findAllByType('HostRouteNoticeBanner' as never)).toHaveLength(0)

    act(() => {
      renderer!.update(
        <MobileProjectList controller={baseController({ connState: 'connected' })} />
      )
    })
    act(() => {
      renderer!.update(
        <MobileProjectList controller={baseController({ connState: 'disconnected' })} />
      )
    })
    expect(renderer!.root.findAllByType('HostRouteNoticeBanner' as never)).toHaveLength(1)

    act(() => {
      renderer!.update(
        <MobileProjectList
          controller={baseController({ relayRecovery: { pairingRejected: true } as never })}
        />
      )
    })
    expect(renderer!.root.findAllByType('AuthFailedBanner' as never)).toHaveLength(1)

    const routerPush = vi.fn()
    act(() => {
      renderer!.update(
        <MobileProjectList
          bottomBarHeight={0}
          controller={baseController({
            connState: 'disconnected',
            reconnectAttempts: 3,
            router: { push: routerPush } as never
          })}
        />
      )
    })
    const diagLink = renderer!.root.findByProps({ accessibilityLabel: 'View network diagnostics' })
    act(() => diagLink.props.onPress())
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/connection-log',
      params: { hostId: 'host-1' }
    })
  })

  it('exposes manual reconnect, Tasks/Automations routes, disconnected guards, and subscribeAll release frames', () => {
    expect(buildRequestStreamUnsubscribe('session.tabs.subscribeAll', {}, 'sub-7')).toEqual({
      method: 'session.tabs.unsubscribeAll',
      params: { subscriptionId: 'sub-7' }
    })
    expect(buildStreamUnsubscribe('session.tabs.subscribeAll', null)).toBeNull()

    const forceReconnectHost = vi.fn()
    const navigateFromHostList = vi.fn()
    const makeHeaderController = (connected: boolean) =>
      ({
        hostId: 'host-1',
        hostDisplay: { title: 'Studio Mac', descriptorLine: null },
        connState: connected ? 'connected' : 'disconnected',
        connectionVerdict: connected
          ? { kind: 'normal', label: 'Connected' }
          : { kind: 'unreachable', label: 'Host unreachable' },
        forceReconnectHost,
        floatingWorkspaceEnabled: true,
        actions: {
          leaveHost: vi.fn(),
          navigateFromHostList,
          openFloatingWorkspace: vi.fn()
        },
        state: { setShowWorkspaceOptions: vi.fn() }
      }) as unknown as HostScreenController

    act(() => {
      renderer = create(<MobileProjectHeader controller={makeHeaderController(false)} />)
    })
    const reconnectBtn = renderer!.root.findByProps({ accessibilityLabel: 'Reconnect' })
    act(() => reconnectBtn.props.onPress())
    expect(forceReconnectHost).toHaveBeenCalledWith('host-1')

    act(() => renderer!.root.findByProps({ accessibilityLabel: 'More' }).props.onPress())
    const disabledPressables = renderer!.root
      .findAllByType('Pressable' as never)
      .filter((node) => node.props.disabled === true)
    expect(disabledPressables).toHaveLength(4)

    act(() => {
      renderer!.update(<MobileProjectHeader controller={makeHeaderController(true)} />)
    })
    const tasksItem = renderer!.root.findByProps({ accessibilityLabel: 'Tasks' })
    act(() => tasksItem.props.onPress())
    expect(navigateFromHostList).toHaveBeenCalledWith('/h/host-1/tasks')

    act(() => renderer!.root.findByProps({ accessibilityLabel: 'More' }).props.onPress())
    const autoItem = renderer!.root.findByProps({ accessibilityLabel: 'Automations' })
    act(() => autoItem.props.onPress())
    expect(navigateFromHostList).toHaveBeenCalledWith('/h/host-1/automations')
  })
})
