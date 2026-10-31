// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

const mainIpc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: {
    fromWebContents: () => ({ id: 17 }),
    fromId: () => ({ isDestroyed: () => false })
  },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mainIpc.handlers.set(name, handler),
    removeHandler: () => {},
    removeAllListeners: () => {},
    on: () => {}
  }
}))

const fixture = vi.hoisted(
  (): {
    client: RpcClient | null
    back: ReturnType<typeof vi.fn>
    replace: ReturnType<typeof vi.fn>
    push: ReturnType<typeof vi.fn>
  } => ({ client: null, back: vi.fn(), replace: vi.fn(), push: vi.fn() })
)
const removedShellCache = vi.hoisted(() => ({
  forgetHostUpdateFailures: vi.fn(async () => {
    throw new Error('Creation must not remove host cache')
  }),
  deleteHostPageCache: vi.fn(async () => {
    throw new Error('Creation must not remove host cache')
  })
}))
vi.mock('../mobile-web-shell/removed-host-shell-cache', () => removedShellCache)
const unregisterPushForRemovedHost = vi.hoisted(() =>
  vi.fn(async (_hostId: string): Promise<() => void> => {
    throw new Error('Creation must not unregister host push')
  })
)
vi.mock('../notifications/push-registration', () => ({ unregisterPushForRemovedHost }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))
// Native feedback stays inert while real drawer selection and close timing execute.
vi.mock('expo-haptics', () => ({
  impactAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  selectionAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Error: 'error', Success: 'success' }
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {}
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  FlatList: ({
    data,
    renderItem
  }: {
    data: unknown[]
    renderItem: (input: { item: unknown; index: number }) => ReactNode
  }) =>
    data.map((item, index) => createElement('View', { key: index }, renderItem({ item, index }))),
  Image: 'Image',
  Keyboard: { dismiss: () => {} },
  Linking: { openURL: async () => {} },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      { get: (_target, name) => (typeof name === 'string' ? name : undefined), has: () => true }
    )
)
vi.mock('./BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))
vi.mock('./bottom-drawer-modal-host', () => ({
  BottomDrawerModalHost: ({ children }: { children: ReactNode }) => children
}))
vi.mock('./AutoHeight', () => ({ AutoHeight: 'AutoHeight' }))
vi.mock('./MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: 'owner-controls' }),
  usePathname: () => '/h/owner-controls',
  useFocusEffect: () => {}
}))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: fixture.client, state: 'connected' }),
  useForgetHostClient: () => () => {},
  useForceReconnect: () => () => {}
}))
vi.mock('./host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({
    hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
    statusReadable: true,
    exactProjectRepoFilters: true
  }),
  useOptionalHostProtocolGates: () => null
}))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => fixture }))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../host-screen/workspace-options-sheet', () => ({ WorkspaceOptionsSheet: () => null }))
vi.mock('../host-screen/workspace-details-sheet', () => ({ WorkspaceDetailsSheet: () => null }))
vi.mock('./ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./ActionSheetModal', () => ({ ActionSheetContent: () => null }))

// Presentation, phone identity and list scroll are outside the catalog→creation path.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false, contentMaxWidth: 800 })
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('../hooks/use-active-worktree-scroll', () => ({ useActiveWorktreeScroll: () => ({}) }))
vi.mock('../transport/client-context-connection-metrics', () => ({
  useReconnectAttempt: () => 0,
  useLastConnectedAt: () => 0,
  useRelayRecoveryStatus: () => ({})
}))
vi.mock('../transport/use-host-display', () => ({ useHostDisplay: () => ({}) }))
vi.mock('../host-screen/use-host-sidebar-feed', () => ({ useSwitchedHostSidebarFeed: () => null }))
vi.mock('../transport/host-store', () => ({
  loadHosts: async () => [{ id: 'owner-controls', name: 'Owner' }],
  updateLastConnected: async () => {}
}))

import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../src/shared/mobile-project-sections-contract'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../src/shared/mobile-relay-hosts-contract'
import { NewWorkspacePageScreen } from '../new-workspace/NewWorkspacePageScreen'
import { HostScreenOverlays } from '../host-screen/host-screen-overlays'
import { useHostScreenController } from '../host-screen/use-host-screen-controller'
import { NewWorktreeProjectTargetFields } from './NewWorktreeProjectTargetFields'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer-constants'
import type * as PublisherFixture from '../../../src/renderer/src/runtime/project-grouping-owner-publication.test-fixture'

let renderer: ReactTestRenderer | undefined
let createProjectGroupingPublisher: typeof PublisherFixture.createProjectGroupingPublisher
let publisher: ReturnType<typeof PublisherFixture.createProjectGroupingPublisher> | undefined
beforeEach(async () => {
  // A new desktop process starts without the catalog retained by a previous process.
  vi.resetModules()
  ;({ createProjectGroupingPublisher } =
    await import('../../../src/renderer/src/runtime/project-grouping-owner-publication.test-fixture'))
})
const reply = (result: unknown): RpcResponse => ({ id: 'reply', ok: true, result })
const executionOptions = z.object({ envelope: z.object({ executionHost: z.string() }) })
const textOf = (node: ReactTestInstance) =>
  node
    .findAll((child) => String(child.type) === 'Text')
    .map((child) => child.props.children)
    .filter((child) => typeof child === 'string')
    .join(' ')
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }
  })
}
afterEach(async () => {
  try {
    try {
      await act(async () => renderer?.unmount())
    } finally {
      renderer = undefined
      await publisher?.dispose()
    }
    expect(removedShellCache.forgetHostUpdateFailures).not.toHaveBeenCalled()
    expect(removedShellCache.deleteHostPageCache).not.toHaveBeenCalled()
    expect(unregisterPushForRemovedHost).not.toHaveBeenCalled()
  } finally {
    publisher = undefined
    fixture.client = null
    vi.useRealTimers()
    vi.clearAllMocks()
  }
})

it.each(['overlay', 'standalone'] as const)(
  'enables actual %s Project/Run/Create after failed then delayed owner read and installed same-client wake',
  async (entrance) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const checkpoint = (phase: string, snapshot?: unknown) =>
      console.info('Creation proof checkpoint', { entrance, phase, snapshot })
    const local = {
      id: 'same',
      path: '/local/app',
      displayName: 'App',
      badgeColor: '',
      addedAt: 0,
      kind: 'git' as const,
      upstream: { owner: 'org', repo: 'app' }
    }
    const server = { ...local, path: '/server/app', executionHostId: 'runtime:server' as const }
    const request = vi.fn<RpcClient['sendRequest']>(async (method, _params, options) => {
      const onServer =
        executionOptions.safeParse(options).data?.envelope.executionHost === 'runtime:server'
      if (method === MOBILE_RELAY_HOSTS_LIST_METHOD) {
        return reply({
          hosts: [
            { hostId: 'runtime:server', label: 'Server', health: 'available', relay: 'ready' }
          ]
        })
      }
      if (method === 'repo.list') {
        return reply({ repos: [onServer ? server : local] })
      }
      if (method === 'status.get') {
        return reply({ hostPlatform: onServer ? 'linux' : 'darwin', capabilities: [] })
      }
      if (method === 'settings.get') {
        return reply({ settings: { defaultTuiAgent: null, disabledTuiAgents: [] } })
      }
      if (method === 'worktree.create') {
        return reply({ worktree: { id: 'created', displayName: 'Proof', path: '/server/proof' } })
      }
      return reply({})
    })
    publisher = createProjectGroupingPublisher(
      mainIpc.handlers,
      async (frame) => {
        const response = await request(frame.method, frame.params, { envelope: frame.envelope })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        return response.result
      },
      checkpoint
    )
    await publisher.mount()
    const client = publisher.client
    fixture.client = client
    let controller!: ReturnType<typeof useHostScreenController>
    function OverlayEntrance() {
      controller = useHostScreenController()
      return createElement(HostScreenOverlays, { controller })
    }
    await act(async () => {
      renderer = create(
        entrance === 'overlay'
          ? createElement(OverlayEntrance)
          : createElement(NewWorkspacePageScreen)
      )
    })
    await flush()
    checkpoint('native entrance mounted')
    if (entrance === 'overlay') {
      expect(controller.state.showNewWorktree).toBe(false)
      await act(async () => controller.actions.openNewWorktreeModal())
      await flush()
    }
    const pressable = (label: string) =>
      renderer!.root
        .findAll((node) => String(node.type) === 'Pressable')
        .find((node) => textOf(node) === label)!
    expect(pressable('Select a project').props.disabled).toBe(true)
    const targetFields = () =>
      renderer!.root
        .findByType(NewWorktreeProjectTargetFields)
        .findAll((node) => String(node.type) === 'Pressable')
    expect(targetFields()).toHaveLength(2)
    expect(targetFields()[1].props.disabled).toBe(true)
    expect(textOf(targetFields()[1])).toContain('/local/app')
    expect(pressable('Create worktree').props.disabled).toBe(true)
    expect(
      publisher.frames.filter((frame) => frame.method === MOBILE_PROJECT_SECTIONS_METHOD).length
    ).toBeGreaterThan(0)
    expect(publisher.read).toThrow('runtime_unavailable')
    checkpoint('initial disabled controls checked')
    await publisher.hydrate([local, server])
    await flush()
    checkpoint('native controls hydrated')
    expect(
      publisher.accepted.at(-1)?.projectSectionCatalog?.repos.map((repo) => repo.path)
    ).toEqual(['/local/app', '/server/app'])
    const projectControl = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => textOf(node).startsWith('App'))!
    expect(projectControl.props.disabled).toBe(false)
    await act(async () => projectControl.props.onPress())
    await act(async () => vi.advanceTimersByTimeAsync(BOTTOM_DRAWER_HIDE_DURATION_MS + 1))
    const projectRow = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => textOf(node).startsWith('App'))!
    await act(async () => projectRow.props.onPress())
    await act(async () => vi.advanceTimersByTimeAsync(BOTTOM_DRAWER_HIDE_DURATION_MS + 1))
    await flush()
    checkpoint('project selected')
    // The field containing the selected checkout path is the real Run-on control.
    const run = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => textOf(node).includes('/local/app'))!
    await act(async () => run.props.onPress())
    await act(async () => vi.advanceTimersByTimeAsync(BOTTOM_DRAWER_HIDE_DURATION_MS + 1))
    const serverRow = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => textOf(node).includes('/server/app'))!
    await act(async () => serverRow.props.onPress())
    await act(async () => vi.advanceTimersByTimeAsync(BOTTOM_DRAWER_HIDE_DURATION_MS + 1))
    await flush()
    checkpoint('server target selected')
    expect(
      request.mock.calls
        .filter(([method]) => method === 'repo.list')
        .some(
          ([, , options]) =>
            executionOptions.safeParse(options).data?.envelope.executionHost === 'runtime:server'
        )
    ).toBe(true)
    await act(async () =>
      renderer!.root
        .find(
          (node) =>
            String(node.type) === 'TextInput' &&
            node.props.placeholder === 'Type a name or search a source'
        )
        .props.onChangeText('Proof')
    )
    expect(pressable('Create worktree').props.disabled).toBe(false)
    await act(async () => pressable('Create worktree').props.onPress())
    await flush()
    checkpoint('create action settled')
    const creates = request.mock.calls.filter(([method]) => method === 'worktree.create')
    expect(creates).toHaveLength(1)
    expect(creates[0]).toEqual([
      'worktree.create',
      expect.objectContaining({ repo: 'id:same' }),
      expect.objectContaining({ envelope: { executionHost: 'runtime:server' } })
    ])
    if (entrance === 'overlay') {
      expect(fixture.push).toHaveBeenCalledWith(
        expect.stringContaining('executionHost=runtime%3Aserver')
      )
      expect(controller.state.showNewWorktree).toBe(false)
    } else {
      expect(fixture.replace).toHaveBeenCalledWith(
        expect.stringContaining('executionHost=runtime%3Aserver')
      )
    }
    checkpoint('routed create and completion checked')
  }
)
