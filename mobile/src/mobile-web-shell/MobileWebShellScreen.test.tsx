import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { FakeRpcClient } from './bridge-host-test-fakes'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

type ScreenDependencies = {
  retry: Mock
  reportShellFailure: Mock
  reportDocumentLoaded: Mock
  reportPageReady: Mock
  /** The profile read rejected, which is the one state that has no host to build against. */
  snapshotUnreadable: boolean
  storageRefreshes: number
  openUrl: Mock
  push: Mock
  back: Mock
  /** What the native stack answers: false is a page opened as the first screen on it. */
  canGoBack: boolean
  pathname: string
  pageRoutes: readonly string[]
  lifecycle: string[]
  state: MobileWebShellSessionState
  /** Null for every case but the bridge's: with no client the hook builds no host at all. */
  client: FakeRpcClient | null
}

const dependencies = vi.hoisted((): ScreenDependencies => {
  // Before the module under test is imported, so its `__DEV__` guard is on and the developer facts
  // are reachable at all — they are the one thing here that must never grow a secret.
  Object.assign(globalThis, { __DEV__: true })
  return {
    retry: vi.fn(),
    reportShellFailure: vi.fn(),
    reportDocumentLoaded: vi.fn(),
    reportPageReady: vi.fn(),
    snapshotUnreadable: false,
    storageRefreshes: 0,
    openUrl: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
    canGoBack: true,
    pathname: '/h/host-1',
    pageRoutes: ['/h/[hostId]'],
    lifecycle: [],
    state: { kind: 'checking' },
    client: null
  }
})

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openURL: dependencies.openUrl },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 8, left: 0, right: 0, top: 44 })
}))
vi.mock('expo-router', () => ({
  router: { replace: vi.fn() },
  useRouter: () => ({
    push: dependencies.push,
    back: dependencies.back,
    canGoBack: () => dependencies.canGoBack
  }),
  // Read by the pop latch, which clears on the route this shell is mounted at changing.
  usePathname: () => dependencies.pathname
}))
// A component rather than a host string: the React key is what makes a retry a rebuilt WebView,
// and a mount/unmount log is the only thing that can tell a remount from a prop update.
vi.mock('../../modules/orca-mobile-web-shell/src', async () => {
  const React = await import('react')
  const loadState = await import('../../modules/orca-mobile-web-shell/src/load-state')
  return {
    OrcaMobileWebShellView: (props: { sessionId: string }) => {
      React.useEffect(() => {
        dependencies.lifecycle.push(`mount:${props.sessionId}`)
        return () => {
          dependencies.lifecycle.push(`unmount:${props.sessionId}`)
        }
      }, [props.sessionId])
      return React.createElement('ShellViewProbe', props)
    },
    parseMobileWebShellLoadState: loadState.parseMobileWebShellLoadState
  }
})
// The real bridge hook runs, so the props it owns are the ones the view is handed here; only the
// client lookup is stubbed, because reaching it imports the Expo runtime this test does not have.
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: dependencies.client })
}))
// Reaching the real one imports the host store and expo-secure-store, whose module touches an Expo
// global this test does not have. What it answers is the screen's input, not its behaviour.
vi.mock('./use-page-host-snapshot', () => ({
  usePageHostSnapshot: () => ({
    snapshot: {
      host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 3 }
    },
    unreadable: dependencies.snapshotUnreadable,
    readStorage: () => ({}),
    refreshStorage: () => {
      dependencies.storageRefreshes += 1
    },
    writeStorage: () => {}
  })
}))
vi.mock('./use-mobile-web-shell-session', () => ({
  useMobileWebShellSession: () => ({
    state: dependencies.state,
    pageRoutes: dependencies.pageRoutes,
    retry: dependencies.retry,
    reportShellFailure: dependencies.reportShellFailure,
    reportDocumentLoaded: dependencies.reportDocumentLoaded,
    reportPageReady: dependencies.reportPageReady
  })
}))

import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { BRIDGE_FAULT_GRANT, BRIDGE_NAVIGATE_BACK_NOTIFY } from './bridge/bridge-envelope'
import { MobileWebShellScreen } from './MobileWebShellScreen'

/** The caller's native screen, as a component so `findAllByType` can name it without a host string. */
function NativeFallback(): null {
  return null
}

const BUILD_ID = 'a1b2c3d4e5f6'.repeat(5) + 'abcd'
const DIRECTORY = '/var/mobile/Containers/Data/Caches/mobile-web/deadbeef/generations/a1b2'

async function render(state: MobileWebShellSessionState): Promise<ReactTestRenderer> {
  dependencies.state = state
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(
      createElement(MobileWebShellScreen, {
        hostId: 'host-1',
        route: { pathname: '/h/host-1' },
        fallback: createElement(NativeFallback)
      })
    )
  })
  if (rendered.tree === null) {
    throw new Error('screen did not render')
  }
  mounted.push(rendered.tree)
  return rendered.tree
}

/** Unmounted between cases: the shell's stack latch is one per stack, so a screen left mounted is
 *  a screen still holding whatever pop it took. */
const mounted: ReactTestRenderer[] = []

function unmountRenderedScreens(): void {
  act(() => {
    for (const tree of mounted.splice(0)) {
      tree.unmount()
    }
  })
}

function readyState(sessionId: string): MobileWebShellSessionState {
  return {
    kind: 'ready',
    generationDirectory: DIRECTORY,
    sessionId,
    buildId: BUILD_ID,
    totalBytes: 4096,
    elapsedMs: 811
  }
}

async function update(tree: ReactTestRenderer, state: MobileWebShellSessionState): Promise<void> {
  dependencies.state = state
  await act(async () => {
    tree.update(
      createElement(MobileWebShellScreen, {
        hostId: 'host-1',
        route: { pathname: '/h/host-1' },
        fallback: createElement(NativeFallback)
      })
    )
  })
}

/** Host elements are matched by name, not by `findAllByType`: React's `ElementType` does not admit
 *  an arbitrary React Native host name, so the typed form is a predicate. */
function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

function textOf(tree: ReactTestRenderer): string {
  return byName(tree, 'Text')
    .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
    .join('\n')
}

afterEach(unmountRenderedScreens)

describe('the hybrid shell screen', () => {
  beforeEach(() => {
    dependencies.retry.mockReset()
    dependencies.reportShellFailure.mockReset()
    dependencies.reportDocumentLoaded.mockReset()
    dependencies.reportPageReady.mockReset()
    dependencies.snapshotUnreadable = false
    dependencies.storageRefreshes = 0
    dependencies.lifecycle.length = 0
    dependencies.client = null
    dependencies.back.mockReset()
    dependencies.openUrl.mockReset()
    dependencies.openUrl.mockImplementation(() => Promise.resolve(true))
    dependencies.canGoBack = true
    dependencies.pathname = '/h/host-1'
  })

  it('renders the update wall for a bundle verdict, with no shell view', async () => {
    const tree = await render({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'bundle-unavailable' }
    })
    expect(textOf(tree)).toContain('Update Orca on your computer')
    expect(byName(tree, 'ShellViewProbe')).toEqual([])
  })

  it('renders the refetch wall a cached generation older than the host earns', async () => {
    const tree = await render({
      kind: 'wall',
      verdict: {
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'mobile',
        bundleRuntimeProtocolVersion: 3,
        requiredBundleRuntimeProtocolVersion: 9
      }
    })
    expect(textOf(tree)).toContain('Refresh the mobile workspace')
  })

  it('offers Try again on a failure a retry can clear', async () => {
    const tree = await render({
      kind: 'failed',
      reason: 'document-load-failed',
      retriedOnce: true
    })
    expect(textOf(tree)).toContain('The downloaded workspace could not be opened.')
    const retry = tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-retry')
    expect(retry).toHaveLength(1)
    await act(async () => {
      retry[0].props.onPress()
    })
    expect(dependencies.retry).toHaveBeenCalledTimes(1)
  })

  it('offers no retry when the device cannot isolate a WebView', async () => {
    const tree = await render({
      kind: 'failed',
      reason: 'isolation-unavailable',
      retriedOnce: false
    })
    expect(textOf(tree)).toContain("This device's WebView is too old")
    expect(tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-retry')).toEqual([])
  })

  it('offers no retry for a status that could not be read, since the gate is settled', async () => {
    const tree = await render({
      kind: 'failed',
      reason: 'status-unreadable',
      retriedOnce: false
    })
    expect(textOf(tree)).toContain("Could not read this host's status")
    expect(tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-retry')).toEqual([])
  })

  it('names what is missing when the host is unreachable and nothing is cached', async () => {
    expect(textOf(await render({ kind: 'offline' }))).toContain(
      'Connect to this host to download the workspace'
    )
  })

  it('counts assets and bytes while downloading', async () => {
    const tree = await render({
      kind: 'fetching',
      completedAssets: 2,
      totalAssets: 4,
      receivedBytes: 2048,
      totalBytes: 4096
    })
    expect(textOf(tree)).toContain('2/4 files')
    expect(textOf(tree)).toContain('2048/4096 bytes')
  })

  it('hands the shell view the generation path and the session id', async () => {
    const tree = await render(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    expect(view.props.generationDirectory).toBe(DIRECTORY)
    expect(view.props.sessionId).toBe('session-one')
  })

  it('opens the bridge channel on a ready session and hands it a receiver', async () => {
    const tree = await render(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    expect(view.props.bridgeEnabled).toBe(true)
    expect(typeof view.props.onBridgeMessage).toBe('function')
    // Delivered with no client behind it: there is no host to answer, and nothing throws.
    await act(async () => {
      view.props.onBridgeMessage({ nativeEvent: { json: '{"v":1,"type":"ready"}' } })
    })
  })

  it('rebuilds the view rather than updating it when the session id changes', async () => {
    const tree = await render(readyState('session-one'))
    await update(tree, readyState('session-two'))
    expect(dependencies.lifecycle).toEqual([
      'mount:session-one',
      'unmount:session-one',
      'mount:session-two'
    ])
  })

  it('forwards a failure the native view reports and drops a payload it cannot read', async () => {
    const tree = await render(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    await act(async () => {
      view.props.onLoadState({ nativeEvent: { state: 'ready' } })
      view.props.onLoadState({ nativeEvent: { state: 'failed', reason: 'invented' } })
      view.props.onLoadState({ nativeEvent: { state: 'failed', reason: 'render-process-gone' } })
    })
    expect(dependencies.reportShellFailure.mock.calls).toEqual([['render-process-gone']])
  })

  it('starts the wait for the page when the native view says the document finished', async () => {
    const tree = await render(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    await act(async () => {
      view.props.onLoadState({ nativeEvent: { state: 'loading' } })
      view.props.onLoadState({ nativeEvent: { state: 'ready' } })
      view.props.onLoadState({ nativeEvent: { state: 'failed', reason: 'document-load-failed' } })
    })
    // Once, for the one finished document, and never for the failure: a view that reported a
    // failure has nothing left to wait for.
    expect(dependencies.reportDocumentLoaded).toHaveBeenCalledTimes(1)
  })

  it('fails the session when this host could not be read from the app store', async () => {
    // Without this the session stays `ready` with the view un-hidden, no host behind it, and the
    // page re-posting `ready` on its backoff for as long as the screen is open.
    dependencies.snapshotUnreadable = true
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await render(readyState('session-one'))
    expect(dependencies.reportShellFailure.mock.calls).toEqual([['document-load-failed']])
    warned.mockRestore()
  })

  it('re-reads the app store on every ask, so the next init is not the first one again', async () => {
    dependencies.client = createFakeRpcClient()
    const tree = await render(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    await act(async () => {
      view.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
      view.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
    })
    // A document that reloads inside one mount asks again; a refresh per ask is what lets a key
    // the app changed meanwhile reach the `init` after it.
    expect(dependencies.storageRefreshes).toBe(2)
  })

  it('ends that wait on the page asking for a session', async () => {
    dependencies.client = createFakeRpcClient()
    const tree = await render(readyState('session-one'))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
    })
    expect(dependencies.reportPageReady).toHaveBeenCalled()
  })

  it('fails the session on a page fault, so a blank page becomes the failure screen', async () => {
    dependencies.client = createFakeRpcClient()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await render(readyState('session-one'))
    await act(async () => {
      // The page asks for its session first, which is what earns it the `fault` grant: a host that
      // has told a page nothing refuses the name.
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({
            type: 'notify',
            name: BRIDGE_FAULT_GRANT,
            error: { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
          })
        }
      })
    })
    expect(dependencies.reportShellFailure.mock.calls).toEqual([['document-load-failed']])
    warned.mockRestore()
    // The reducer's answer to that reason, rendered: this is what the page's blank turns into.
    expect(
      textOf(await render({ kind: 'failed', reason: 'document-load-failed', retriedOnce: true }))
    ).toContain('The downloaded workspace could not be opened.')
  })

  it('reports a URL nothing on this phone could open, which is the dead tap that survives', async () => {
    dependencies.client = createFakeRpcClient()
    const failure = new Error('no activity found')
    // A fresh rejection per call, not one built here: `mockReturnValue(Promise.reject(...))` builds
    // it now and nothing attaches a handler until the frame arrives, which is an unhandled
    // rejection in the window between.
    dependencies.openUrl.mockImplementation(() => Promise.reject(failure))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await render(readyState('session-one'))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({
            type: 'notify',
            name: 'externalLink',
            url: 'mailto:someone@example.com'
          })
        }
      })
    })
    // Nothing crosses back for a notify, so silence here is the one dead tap this verb does not
    // rule out: the page was told the frame left and the phone opened nothing.
    expect(warned.mock.calls).toContainEqual([
      '[web-shell] could not open a URL for the page',
      { url: 'mailto:someone@example.com', error: failure }
    ])
    warned.mockRestore()
  })

  it('pops its own stack when the page hands its back button over', async () => {
    dependencies.client = createFakeRpcClient()
    const tree = await render(readyState('session-one'))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }) }
      })
    })
    expect(dependencies.back).toHaveBeenCalledTimes(1)
    expect(dependencies.push).not.toHaveBeenCalled()
  })

  it('pops nothing when this page is the first screen on the stack, rather than dismissing it', async () => {
    dependencies.client = createFakeRpcClient()
    dependencies.canGoBack = false
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await render(readyState('session-one'))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }) }
      })
    })
    expect(dependencies.back).not.toHaveBeenCalled()
    // The page is told nothing either way, so the log is the only thing a dead Back button leaves.
    expect(warned.mock.calls).toContainEqual([
      '[web-shell-bridge] did not pop the stack for a page going back',
      { why: 'nothing-to-pop' }
    ])
    warned.mockRestore()
  })

  it('shows a build id prefix and never the whole one, the cache path, or the host id', async () => {
    const tree = await render(readyState('session-one'))
    const text = textOf(tree)
    expect(text).toContain(BUILD_ID.slice(0, 12))
    expect(text).toContain('4096 B')
    expect(text).toContain('811 ms')
    expect(text).not.toContain(BUILD_ID)
    expect(text).not.toContain(DIRECTORY)
    expect(text).not.toContain('host-1')
  })
})

describe('the route the shell was not asked to render', () => {
  it('hands the screen back to the caller rather than painting anything of its own', async () => {
    const tree = await render({ kind: 'native-route' })
    expect(tree.root.findAllByType(NativeFallback)).toHaveLength(1)
    expect(byName(tree, 'ShellViewProbe')).toEqual([])
    expect(byName(tree, 'ActivityIndicator')).toEqual([])
  })
})
