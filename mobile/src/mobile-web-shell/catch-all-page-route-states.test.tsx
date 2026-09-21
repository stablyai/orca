/**
 * What the catch-all paints for each state the shell settles on, with the real shell screen and the
 * real refusal underneath it.
 *
 * `catch-all-page-route.test.tsx` mocks both and reads what the switch hands over; this drives the
 * other half — the session reducer is the only thing stubbed, so the screen the user sees for
 * `native-route`, `offline`, `checking` and the wall is the one this app ships.
 */
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
  storage: Map<string, string>
}

const SNAPSHOT = vi.hoisted(() => ({
  host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 3 }
}))

const dependencies = vi.hoisted((): Dependencies => {
  Object.assign(globalThis, { __DEV__: true })
  return {
    state: { kind: 'native-route' },
    params: {},
    replace: vi.fn(),
    push: vi.fn(),
    storage: new Map()
  }
})

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
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
// Dictation's device half, which the shell screen reaches through the audio verbs. The real module
// touches the Expo global at import and this test has none; what each verb does is
// `bridge-audio-verbs.test.ts`.
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
  default: {
    getItem: async (key: string) => dependencies.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      dependencies.storage.set(key, value)
    }
  }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 8, left: 0, right: 0, top: 44 })
}))
vi.mock('expo-router', () => ({
  router: { replace: vi.fn() },
  useLocalSearchParams: () => dependencies.params,
  useRouter: () => ({
    push: dependencies.push,
    replace: dependencies.replace,
    back: vi.fn(),
    canGoBack: () => false
  }),
  usePathname: () => '/h/host-1'
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
vi.mock('../transport/client-context', () => ({ useHostClient: () => ({ client: null }) }))
vi.mock('./use-page-host-snapshot', () => ({
  usePageHostSnapshot: () => ({
    snapshot: SNAPSHOT,
    unreadable: false,
    readStorage: () => ({}),
    refreshStorage: () => {},
    writeStorage: () => {}
  })
}))
// The one thing stubbed: what the reducer settled on. Everything below it is the shipped screen.
vi.mock('./use-mobile-web-shell-session', () => ({
  useMobileWebShellSession: () => ({
    state: dependencies.state,
    pageRoutes: [],
    pageRouteGrants: [],
    routeGrants: [],
    retry: vi.fn(),
    reportShellFailure: vi.fn(),
    reportDocumentLoaded: vi.fn(),
    reportPageReady: vi.fn()
  })
}))

import MobileWebPageCatchAllScreen from './catch-all-page-route'

const BACK_LABEL = 'Back to workspaces'
/** What the same control says when there is no host to go back to. */
const ROOT_LABEL = 'Back to hosts'

/**
 * Rendered with the flag read settled, which is the precondition every case here needs.
 *
 * Until it settles the switch returns the refusal directly, without the shell — so a case that
 * asserted the refusal on one flush would pass against a screen the shell never rendered, and the
 * `fallback` binding it means to pin would be untested. Two flushes and then a check that the
 * switch is past that branch.
 */
async function renderRoute(state: MobileWebShellSessionState): Promise<ReactTestRenderer> {
  dependencies.state = state
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(MobileWebPageCatchAllScreen))
  })
  await act(async () => {
    await Promise.resolve()
  })
  if (rendered.tree === null) {
    throw new Error('the catch-all route rendered nothing')
  }
  return rendered.tree
}

/** `react-native` is mocked to host strings, which `findAllByType` does not take as an ElementType. */
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
  dependencies.storage.clear()
  dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
})

describe('the screen the catch-all paints for each shell state', () => {
  it('renders the refusal through the shell fallback, not beside it', async () => {
    // `native-route` is the only state that reaches `fallback`, so this is what pins that binding:
    // with `fallback={null}` the shell paints nothing and the control below is gone.
    const tree = await renderRoute({ kind: 'native-route' })
    expect(textOf(tree)).toContain('This workspace screen is not available on this host.')
    expect(backControl(tree)).toBeDefined()
  })

  it('leaves the dead end rather than stacking it, on the encoded host route', async () => {
    const tree = await renderRoute({ kind: 'native-route' })
    await act(async () => {
      backControl(tree).props.onPress()
    })
    expect(dependencies.replace).toHaveBeenCalledWith('/h/host-1')
    expect(dependencies.push).not.toHaveBeenCalled()
  })

  /**
   * The five shapes the host-list switch already pins, on the way back out.
   *
   * A raw template here builds `/h/a/b` for the id `a/b`, which the catch-all above it matches with
   * `hostId` now `a` — the control loops back into the screen it is meant to leave.
   */
  it('encodes the host id into the route it leaves on', async () => {
    for (const hostId of ['a?b', 'a#b', 'a b', 'a/b', 'a\\b']) {
      dependencies.params = { hostId, page: ['settings'] }
      dependencies.replace.mockClear()
      const tree = await renderRoute({ kind: 'native-route' })
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

  /**
   * An absent host id, which `firstParam` answers as `''`.
   *
   * The raw call sends this control to `/h/`, which expo-router's own matcher resolves to the `h`
   * layout with no child — a press that paints nothing and leaves the dead end in place. The app
   * root is the screen that lists hosts, and is where `ProtocolBlockScreen` sends the same gesture.
   */
  it('goes to the app root when there is no host to go back to', async () => {
    dependencies.params = { page: ['settings'] }
    const tree = await renderRoute({ kind: 'native-route' })
    await act(async () => {
      backControl(tree, ROOT_LABEL).props.onPress()
    })
    expect(dependencies.replace).toHaveBeenCalledWith('/')
    expect(dependencies.replace).not.toHaveBeenCalledWith('/h/')
    expect(dependencies.push).not.toHaveBeenCalled()
  })

  /**
   * Offline is the shell's message and not the refusal, on purpose.
   *
   * The refusal answers one question — this build cannot serve this route — and the other states
   * answer different ones that are all true for a screen only the page has: offline means the
   * bundle that would serve it cannot be fetched, `checking` means the answer is not in yet, and
   * the wall means no page can be served at all. Folding them into the refusal would tell someone
   * with no connection that the screen does not exist.
   */
  it('says the host is unreachable rather than that the screen is unavailable', async () => {
    const tree = await renderRoute({ kind: 'offline' })
    const text = textOf(tree)
    expect(text).toContain('Connect to this host to download the workspace')
    expect(text).not.toContain('This workspace screen is not available on this host.')
  })

  /**
   * The presence precondition for every case above: the shell is what rendered them.
   *
   * Before the flag read settles the switch returns the refusal on its own, with the same text and
   * the same control, so the two cases that assert the refusal would pass against a screen no shell
   * ever saw. `Checking host` is a string only the shell paints, and the switch cannot reach this
   * state without having mounted one.
   */
  it('waits on the shell while the answer is still coming', async () => {
    const tree = await renderRoute({ kind: 'checking' })
    expect(textOf(tree)).toContain('Checking host')
    expect(textOf(tree)).not.toContain('This workspace screen is not available on this host.')
  })
})
