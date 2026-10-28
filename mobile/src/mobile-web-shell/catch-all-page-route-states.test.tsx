// Render real shell/refusal screens under a stubbed reducer; the sibling switch suite mocks them and cannot verify user-visible fallback states.
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { OrcaMobileWebShellViewProps } from '../../modules/orca-mobile-web-shell/src'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

type Dependencies = {
  state: MobileWebShellSessionState
  params: Record<string, string | string[] | undefined>
  replace: Mock
  push: Mock
}

const SNAPSHOT = vi.hoisted(() => ({
  host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 3 }
}))

const dependencies = vi.hoisted((): Dependencies => {
  Object.assign(globalThis, { __DEV__: true })
  return {
    state: { kind: 'route-unavailable' },
    params: {},
    replace: vi.fn(),
    push: vi.fn()
  }
})

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Keyboard: { addListener: () => ({ remove: () => {} }) },
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('expo-clipboard', () => ({
  setStringAsync: () => Promise.resolve(true),
  getStringAsync: () => Promise.resolve('')
}))
vi.mock('expo-haptics', () => ({
  impactAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  selectionAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Error: 'error', Success: 'success' }
}))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: () => Promise.resolve(null) }))
// Mock Expo audio imports; verb behavior is covered by bridge-audio-verbs.test.ts.
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () =>
    Promise.resolve({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' }),
  tearDown: () => {},
  toggleRecording: () => true
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: () => Promise.resolve({ canceled: true }),
  requestMediaLibraryPermissionsAsync: () => Promise.resolve({ granted: false })
}))
vi.mock('expo-file-system', () => ({
  File: class {
    readonly size = 0
    delete(): void {}
  },
  Paths: { cache: 'file:///cache' }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
vi.mock('lucide-react-native', () => ({ X: 'Icon' }))
vi.mock('react-native-safe-area-context', async () => {
  const { createContext } = await import('react')
  return {
    useSafeAreaInsets: () => ({ bottom: 8, left: 0, right: 0, top: 44 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    SafeAreaFrameContext: createContext(null),
    SafeAreaInsetsContext: createContext(null),
    SafeAreaProvider: ({ children }: { children: unknown }) => children
  }
})
vi.mock('expo-router', () => ({
  router: { replace: vi.fn() },
  useLocalSearchParams: () => dependencies.params,
  useRouter: () => ({
    push: dependencies.push,
    replace: dependencies.replace,
    back: vi.fn(),
    canGoBack: () => false
  }),
  usePathname: () => '/h/host-1',
  useNavigation: () => ({ setOptions: vi.fn() }),
  useNavigationContainerRef: () => ({ getRootState: () => undefined }),
  useFocusEffect: () => {}
}))
vi.mock('../../modules/orca-mobile-web-shell/src', async () => {
  const React = await import('react')
  const loadState = await import('../../modules/orca-mobile-web-shell/src/load-state')
  return {
    OrcaMobileWebShellView: (props: OrcaMobileWebShellViewProps) =>
      React.createElement('ShellViewProbe', props),
    parseMobileWebShellLoadState: loadState.parseMobileWebShellLoadState
  }
})
vi.mock('../app-update/use-wall-app-update', () => ({
  useWallAppUpdate: () => null
}))
vi.mock('../transport/host-client-hooks', () => ({ useHostClient: () => ({ client: null }) }))
vi.mock('./use-page-host-snapshot', () => ({
  usePageHostSnapshot: () => ({
    snapshot: SNAPSHOT,
    unreadable: false,
    readStorage: () => ({ storage: {}, storageOversize: [] }),
    refreshStorage: () => {},
    writeStorage: () => {}
  })
}))
vi.mock('./use-mobile-web-shell-session', () => ({
  useMobileWebShellSession: () => ({
    state: dependencies.state,
    pageRoutes: [],
    pageRouteGrants: [],
    routeGrants: [],
    updateNotice: null,
    retry: vi.fn(),
    reportShellFailure: vi.fn(),
    reportDocumentLoaded: vi.fn(),
    reportPageReady: vi.fn()
  })
}))

import MobileWebPageCatchAllScreen from './catch-all-page-route'

const BACK_LABEL = 'Back to workspaces'
const ROOT_LABEL = 'Back to hosts'

async function renderRoute(state: MobileWebShellSessionState): Promise<ReactTestRenderer> {
  dependencies.state = state
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(MobileWebPageCatchAllScreen))
  })
  if (rendered.tree === null) {
    throw new Error('the catch-all route rendered nothing')
  }
  return rendered.tree
}

function hostNodes(tree: ReactTestRenderer, host: string): ReactTestInstance[] {
  return tree.root.findAll((node) => node.type === host)
}

function backControl(tree: ReactTestRenderer, label: string = BACK_LABEL): ReactTestInstance {
  const found = hostNodes(tree, 'Pressable').filter(
    (node) => node.props.accessibilityLabel === label
  )
  expect(found.length, `one control labelled "${label}"`).toBe(1)
  return found[0]!
}

function textOf(tree: ReactTestRenderer): string {
  return hostNodes(tree, 'Text')
    .flatMap((node) => (Array.isArray(node.children) ? node.children : []))
    .filter((child): child is string => typeof child === 'string')
    .join(' ')
}

beforeEach(() => {
  dependencies.params = { hostId: 'host-1', page: ['settings'] }
  dependencies.replace.mockClear()
  dependencies.push.mockClear()
})

describe('the screen the catch-all paints for each shell state', () => {
  it('shows the refusal when the shell finds the page does not serve the pathname', async () => {
    const tree = await renderRoute({ kind: 'route-unavailable' })
    expect(textOf(tree)).toContain('This workspace screen is not available on this host.')
    expect(textOf(tree)).not.toContain('too old')
    expect(backControl(tree)).toBeDefined()
  })

  it('shows the same refusal, with no shell mounted, for a pathname naming no screen', async () => {
    dependencies.params = { hostId: 'host-1', page: [] }
    const tree = await renderRoute({ kind: 'checking' })
    expect(textOf(tree)).toContain('This workspace screen is not available on this host.')
    expect(backControl(tree)).toBeDefined()
  })

  it('leaves the dead end rather than stacking it, on the encoded host route', async () => {
    const tree = await renderRoute({ kind: 'route-unavailable' })
    await act(async () => {
      backControl(tree).props.onPress()
    })
    expect(dependencies.replace).toHaveBeenCalledWith('/h/host-1')
    expect(dependencies.push).not.toHaveBeenCalled()
  })

  // Encode host ids: a/b interpolated raw loops into this catch-all as /h/a/b with hostId a.
  it('encodes the host id into the route it leaves on', async () => {
    for (const hostId of ['a?b', 'a#b', 'a b', 'a/b', 'a\\b']) {
      dependencies.params = { hostId, page: ['settings'] }
      dependencies.replace.mockClear()
      const tree = await renderRoute({ kind: 'route-unavailable' })
      await act(async () => {
        backControl(tree).props.onPress()
      })
      expect(dependencies.replace, hostId).toHaveBeenCalledWith(`/h/${encodeURIComponent(hostId)}`)
      expect(
        decodeURIComponent(String(dependencies.replace.mock.calls[0]?.[0]).slice('/h/'.length)),
        hostId
      ).toBe(hostId)
    }
  })

  // Missing host ids must return to app root; /h/ resolves to an empty layout and leaves the escape control at a dead end.
  it('goes to the app root when there is no host to go back to', async () => {
    dependencies.params = { page: ['settings'] }
    const tree = await renderRoute({ kind: 'route-unavailable' })
    await act(async () => {
      backControl(tree, ROOT_LABEL).props.onPress()
    })
    expect(dependencies.replace).toHaveBeenCalledWith('/')
    expect(dependencies.replace).not.toHaveBeenCalledWith('/h/')
    expect(dependencies.push).not.toHaveBeenCalled()
  })

  // Keep offline/checking/protocol-wall states distinct from route refusal; missing connection is not evidence the screen does not exist.
  it('says the host is unreachable rather than that the screen is unavailable', async () => {
    const tree = await renderRoute({ kind: 'offline' })
    const text = textOf(tree)
    expect(text).toContain('Connect to this host to download the latest app')
    expect(text).not.toContain('This workspace screen is not available on this host.')
  })

  // Assert Checking host to prove the shell mounted; bare refusals can render without it and would satisfy refusal-only assertions.
  it('waits on the shell while the answer is still coming', async () => {
    const tree = await renderRoute({ kind: 'checking' })
    expect(textOf(tree)).toContain('Checking host')
    expect(textOf(tree)).not.toContain('This workspace screen is not available on this host.')
  })
})
