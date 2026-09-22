import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())
const SNAPSHOT = harness.SCREEN_SNAPSHOT

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Easing: { in: (fn: unknown) => fn, quad: 'quad' },
  // Enough of it for the cover to mount, fade and unmount. What the fade looks like is not this
  // test's business; that the cover is up until the page paints is, and that is the `visible` prop.
  Animated: {
    View: 'Animated.View',
    Value: class {
      setValue(): void {}
    },
    timing: () => ({
      start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
      stop: () => {}
    })
  },
  Keyboard: {
    addListener: (
      name: string,
      listener: (event: { endCoordinates: { height: number } }) => void
    ) => {
      dependencies.keyboardListeners.set(name, listener)
      return { remove: () => dependencies.keyboardListeners.delete(name) }
    }
  },
  Linking: { openURL: dependencies.openUrl },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: {
    create: (styles: unknown) => styles,
    // The real values, so a case that reads them off the cover reads something.
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
  },
  Text: 'Text',
  View: 'View'
}))
// Reaching the real one imports the Expo runtime this test does not have. The screen only passes
// the handler through; what it does with a verb is `native-clipboard.test.ts`.
vi.mock('expo-clipboard', () => ({
  setStringAsync: () => Promise.resolve(true),
  getStringAsync: () => Promise.resolve('')
}))
// Same reason, and the screen only hands `playPageHaptic` over: which expo member each kind
// reaches is `page-haptics.test.ts`. `Platform.OS` above is pinned to `ios`, so the Android
// members are never evaluated and are not listed.
vi.mock('expo-haptics', () => ({
  impactAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  selectionAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Error: 'error', Success: 'success' }
}))
vi.mock('expo-document-picker', () => ({ getDocumentAsync: () => Promise.resolve(null) }))
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
vi.mock('lucide-react-native', () => ({ X: 'Icon' }))
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
    OrcaMobileWebShellView: (props: {
      sessionId: string
      ref?: (handle: { postBridgeMessage: (json: string) => Promise<void> } | null) => void
    }) => {
      dependencies.viewRenders += 1
      React.useEffect(() => {
        dependencies.lifecycle.push(`mount:${props.sessionId}`)
        return () => {
          dependencies.lifecycle.push(`unmount:${props.sessionId}`)
        }
      }, [props.sessionId])
      // The handle the real view exposes, which nothing here used to attach: without it every
      // post rejected as a view that is gone, so no case could see a frame reach the page.
      const attach = props.ref
      React.useLayoutEffect(() => {
        attach?.({
          postBridgeMessage: (json: string) => {
            dependencies.posted.push(json)
            return dependencies.postFails
              ? Promise.reject(new Error('the view would not take it'))
              : Promise.resolve()
          }
        })
        return () => {
          attach?.(null)
        }
      }, [attach])
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
    // One object for the life of the file, as the real hook's `useState` gives. A fresh literal per
    // render changes the identity the host effect is keyed on, so the bridge host was being torn
    // down and rebuilt on every render of this screen — and every pending request settled with it.
    snapshot: SNAPSHOT,
    unreadable: dependencies.snapshotUnreadable,
    readStorage: () => ({ storage: {}, storageOversize: [] }),
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
    routeGrants: dependencies.routeGrants,
    updateNotice: dependencies.updateNotice,
    retry: dependencies.retry,
    reportShellFailure: dependencies.reportShellFailure,
    reportDocumentStarted: dependencies.reportDocumentStarted,
    reportDocumentLoaded: dependencies.reportDocumentLoaded,
    reportPageReady: dependencies.reportPageReady,
    reportPagePainted: dependencies.reportPagePainted,
    pageReady: dependencies.pageReady,
    pageFrame: dependencies.pageFrame
  })
}))

import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { bridgeId, clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import {
  byName,
  DEFAULT_ROUTE_GRANTS,
  trackRenderedScreen,
  NativeFallback,
  SCREEN_BUILD_ID as BUILD_ID,
  SCREEN_DIRECTORY as DIRECTORY,
  hostParentOf,
  readyState,
  renderScreen as mountScreen,
  textOf,
  updateScreen as reRenderScreen
} from './mobile-web-shell-screen-test-harness'
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  readBridgeHostMessage
} from './bridge/bridge-envelope'
import { BRIDGE_ROUTE_UPDATE_ACCEPT } from './bridge/bridge-route-update'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'

const renderScreen = (state: MobileWebShellSessionState): Promise<ReactTestRenderer> =>
  mountScreen(MobileWebShellScreen, dependencies, state)

const updateScreen = (tree: ReactTestRenderer, state: MobileWebShellSessionState): Promise<void> =>
  reRenderScreen(MobileWebShellScreen, dependencies, tree, state)

afterEach(harness.unmountRenderedScreens)

beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
})

describe('the hybrid shell screen', () => {
  it('renders the update wall for a bundle verdict, with no shell view', async () => {
    const tree = await renderScreen({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'bundle-unavailable' }
    })
    expect(textOf(tree)).toContain('Update Orca on your computer')
    expect(byName(tree, 'ShellViewProbe')).toEqual([])
  })

  it('renders the refetch wall a cached generation older than the host earns', async () => {
    const tree = await renderScreen({
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
    const tree = await renderScreen({
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
    const tree = await renderScreen({
      kind: 'failed',
      reason: 'isolation-unavailable',
      retriedOnce: false
    })
    expect(textOf(tree)).toContain("This device's WebView is too old")
    expect(tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-retry')).toEqual([])
  })

  it('offers no retry for a status that could not be read, since the gate is settled', async () => {
    const tree = await renderScreen({
      kind: 'failed',
      reason: 'status-unreadable',
      retriedOnce: false
    })
    expect(textOf(tree)).toContain("Could not read this host's status")
    expect(tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-retry')).toEqual([])
  })

  it('names what is missing when the host is unreachable and nothing is cached', async () => {
    expect(textOf(await renderScreen({ kind: 'offline' }))).toContain(
      'Connect to this host to download the workspace'
    )
  })

  it('counts assets and bytes while downloading', async () => {
    const tree = await renderScreen({
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
    const tree = await renderScreen(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    expect(view.props.generationDirectory).toBe(DIRECTORY)
    expect(view.props.sessionId).toBe('session-one')
  })

  it('opens the bridge channel on a ready session and hands it a receiver', async () => {
    const tree = await renderScreen(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    expect(view.props.bridgeEnabled).toBe(true)
    expect(typeof view.props.onBridgeMessage).toBe('function')
    // Delivered with no client behind it: there is no host to answer, and nothing throws.
    await act(async () => {
      view.props.onBridgeMessage({ nativeEvent: { json: '{"v":1,"type":"ready"}' } })
    })
  })

  it('rebuilds the view rather than updating it when the session id changes', async () => {
    const tree = await renderScreen(readyState('session-one'))
    await updateScreen(tree, readyState('session-two'))
    expect(dependencies.lifecycle).toEqual([
      'mount:session-one',
      'unmount:session-one',
      'mount:session-two'
    ])
  })

  it('forwards a failure the native view reports and drops a payload it cannot read', async () => {
    const tree = await renderScreen(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    await act(async () => {
      view.props.onLoadState({ nativeEvent: { state: 'ready' } })
      view.props.onLoadState({ nativeEvent: { state: 'failed', reason: 'invented' } })
      view.props.onLoadState({ nativeEvent: { state: 'failed', reason: 'render-process-gone' } })
    })
    expect(dependencies.reportShellFailure.mock.calls).toEqual([['render-process-gone']])
  })

  it('starts the wait for the page when the native view says the document finished', async () => {
    const tree = await renderScreen(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    await act(async () => {
      view.props.onLoadState({ nativeEvent: { state: 'loading' } })
      view.props.onLoadState({ nativeEvent: { state: 'ready' } })
      view.props.onLoadState({ nativeEvent: { state: 'failed', reason: 'document-load-failed' } })
    })
    // Once, for the one finished document, and never for the failure: a view that reported a
    // failure has nothing left to wait for.
    expect(dependencies.reportDocumentLoaded).toHaveBeenCalledTimes(1)
    // The document that started is what drops the previous one's paint, so it is reported too.
    expect(dependencies.reportDocumentStarted).toHaveBeenCalledTimes(1)
  })

  it('fails the session when this host could not be read from the app store', async () => {
    // Without this the session stays `ready` with the view un-hidden, no host behind it, and the
    // page re-posting `ready` on its backoff for as long as the screen is open.
    dependencies.snapshotUnreadable = true
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await renderScreen(readyState('session-one'))
    expect(dependencies.reportShellFailure.mock.calls).toEqual([['document-load-failed']])
    warned.mockRestore()
  })

  it('re-reads the app store on every ask, so the next init is not the first one again', async () => {
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    await act(async () => {
      view.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
      view.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
    })
    // A document that reloads inside one mount asks again; a refresh per ask is what lets a key
    // the app changed meanwhile reach the `init` after it.
    expect(dependencies.storageRefreshes).toBe(2)
  })

  /**
   * One screen whose route this case moves, and every frame that went out for it.
   *
   * The shell tracks nothing about delivery (ruling 34): what a case can see here is what reached
   * the wire, and the request a frame carried is spent by the page, not by this screen.
   */
  async function renderForRoute(params: Record<string, string>): Promise<{
    tree: ReactTestRenderer
    initRoutes: () => (Record<string, string> | undefined)[]
    move: (next: Record<string, string>) => Promise<void>
    ready: (accepts?: readonly string[]) => Promise<void>
  }> {
    const element = (next: Record<string, string>) =>
      createElement(MobileWebShellScreen, {
        hostId: 'host-1',
        route: { pathname: '/h/host-1', params: next },
        fallback: createElement(NativeFallback)
      })
    dependencies.state = readyState('session-one')
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      rendered.tree = create(element(params))
    })
    const tree = rendered.tree
    if (tree === null) {
      throw new Error('screen did not render')
    }
    trackRenderedScreen(tree)
    return {
      tree,
      // Read with the page's own reader rather than parsed loose: a frame this refuses is one the
      // page would have refused too, and a case counting inits must not count one of those.
      initRoutes: () =>
        dependencies.posted
          .map((json) => readBridgeHostMessage(json))
          .flatMap((read) => (read.ok && read.message.type === 'init' ? [read.message] : []))
          .map((frame) => frame.route?.params),
      move: async (next) => {
        await act(async () => {
          tree.update(element(next))
        })
      },
      ready: async (accepts = [BRIDGE_ROUTE_UPDATE_ACCEPT]) => {
        await act(async () => {
          byName(tree, 'ShellViewProbe')[0]?.props.onBridgeMessage({
            nativeEvent: { json: clientFrame({ type: 'ready', accepts }) }
          })
        })
      }
    }
  }

  /**
   * A route that moved under a screen that stayed mounted (ruling 33.1, as ruling 34 leaves it).
   *
   * One frame per move and none for a render that moved nothing. Whether it arrived is not asked
   * here and is not asked anywhere: the page's next `ready` is answered with the route the shell
   * holds then, which is the whole repair path.
   */
  it('posts one init for a route that moved, and none for a render that moved nothing', async () => {
    dependencies.client = createFakeRpcClient()
    const page = await renderForRoute({ paneKey: '' })
    await page.ready()
    expect(page.initRoutes()).toEqual([{ paneKey: '' }])
    await page.move({ paneKey: 'pane-1' })
    expect(page.initRoutes()).toEqual([{ paneKey: '' }, { paneKey: 'pane-1' }])
    await page.move({ paneKey: 'pane-1' })
    expect(page.initRoutes()).toHaveLength(2)
  })

  it('answers every ask with the route it holds then, which is how a lost frame is repaired', async () => {
    dependencies.client = createFakeRpcClient()
    dependencies.postFails = true
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const page = await renderForRoute({ paneKey: '' })
    await page.ready()
    await page.move({ paneKey: 'pane-1' })
    // Both frames were refused by the view, and nothing here is holding either of them.
    expect(dependencies.posted).toHaveLength(2)
    dependencies.postFails = false
    await page.ready()
    expect(page.initRoutes().at(-1)).toEqual({ paneKey: 'pane-1' })
    warned.mockRestore()
  })

  it('sends no second init to a page that never said it takes one', async () => {
    dependencies.client = createFakeRpcClient()
    const page = await renderForRoute({ paneKey: '' })
    // A page built before route updates existed declares nothing, and reads a second `init` as a
    // replacement: the route still moves, so its next `ready` is answered with the new one.
    await page.ready([])
    await page.move({ paneKey: 'pane-1' })
    expect(page.initRoutes()).toEqual([{ paneKey: '' }])
    await page.ready([])
    expect(page.initRoutes()).toEqual([{ paneKey: '' }, { paneKey: 'pane-1' }])
  })

  it('ends that wait on the page asking for a session', async () => {
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState('session-one'))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
    })
    expect(dependencies.reportPageReady).toHaveBeenCalled()
  })

  /**
   * The host is rebuilt when the client under it changes, and the page is never told: the session
   * id does not move, so it neither handshakes again nor hears that the shell was replaced. The
   * screen hands over what its reducer already knows about the session rather than the bridge
   * remembering it for the life of one mount.
   */
  it('serves a page whose session handshook before this host was built', async () => {
    const client = createFakeRpcClient()
    dependencies.client = client
    dependencies.pageReady = true
    const tree = await renderScreen(readyState('session-one'))
    // No `ready` first, which is exactly what a page that was never told cannot send.
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({ type: 'request', id: bridgeId(1), method: 'status.get' })
        }
      })
    })
    expect(client.requests.map((request) => request.method)).toEqual(['status.get'])
  })

  it('fails the session on a page fault, so a blank page becomes the failure screen', async () => {
    dependencies.client = createFakeRpcClient()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await renderScreen(readyState('session-one'))
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
      textOf(
        await renderScreen({ kind: 'failed', reason: 'document-load-failed', retriedOnce: true })
      )
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
    const tree = await renderScreen(readyState('session-one'))
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
    const tree = await renderScreen(readyState('session-one'))
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
    const tree = await renderScreen(readyState('session-one'))
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
    const tree = await renderScreen(readyState('session-one'))
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
    const tree = await renderScreen({ kind: 'native-route' })
    expect(tree.root.findAllByType(NativeFallback)).toHaveLength(1)
    expect(byName(tree, 'ShellViewProbe')).toEqual([])
    expect(byName(tree, 'ActivityIndicator')).toEqual([])
  })
})

describe('the dropped-frame count on the dev facts line', () => {
  /** 500,000 bytes encodes past the frame cap, so every one of these is dropped. */
  const oversized = {
    opcode: 1 as const,
    seq: 1,
    format: 'jpeg' as const,
    metadata: {},
    image: new Uint8Array(500_000)
  }

  async function openBinaryStream(tree: ReactTestRenderer): Promise<void> {
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0]?.props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
    })
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0]?.props.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({
            type: 'subscribe',
            id: 'a'.repeat(22),
            method: 'browser.screencast',
            params: {},
            wantsBinary: true
          })
        }
      })
    })
  }

  async function drop(times: number): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await act(async () => {
        dependencies.client?.streams[0]?.emitBinary?.({ ...oversized, seq: index + 1 })
      })
    }
  }

  function devFactsText(tree: ReactTestRenderer): string | null {
    const line = byName(tree, 'Text').find(
      (node) => node.props.testID === 'mobile-web-shell-dev-facts'
    )
    return line === undefined ? null : String(line.props.children)
  }

  it('shows the running total and resets it when the host is rebuilt', async () => {
    dependencies.client = createFakeRpcClient()
    dependencies.routeGrants = ['navigate', 'screencastBinary']
    const tree = await renderScreen(readyState('session-one'))
    await openBinaryStream(tree)
    await drop(2)
    expect(devFactsText(tree)).toContain('2 frames dropped')
    await updateScreen(tree, readyState('session-two'))
    expect(devFactsText(tree)).not.toContain('dropped')
  })

  /**
   * The line renders null outside a development build, so state behind it is a re-render of the
   * whole screen for a fact nobody can see — at up to ten a second on a page the desktop cannot
   * compress. Counted rather than reasoned about.
   */
  it('renders the screen not once more per dropped frame in a production build', async () => {
    Object.assign(globalThis, { __DEV__: false })
    try {
      dependencies.client = createFakeRpcClient()
      dependencies.routeGrants = ['navigate', 'screencastBinary']
      const tree = await renderScreen(readyState('session-one'))
      await openBinaryStream(tree)
      expect(devFactsText(tree)).toBeNull()
      const before = dependencies.viewRenders
      await drop(5)
      expect({ extraRenders: dependencies.viewRenders - before }).toEqual({ extraRenders: 0 })
      expect(devFactsText(tree)).toBeNull()
    } finally {
      Object.assign(globalThis, { __DEV__: true })
    }
  })
})

/**
 * An update the session refused, over a workspace the session opened anyway.
 *
 * The decision is the reducer's; what this pins is that the screen keeps the two apart — the
 * refusal is a line above the page, so a dismissed notice leaves the same document mounted rather
 * than reloading it, and the copy claims only what happened.
 */
describe('a refused update is said beside the page, not in front of it', () => {
  function dismissControl(tree: ReactTestRenderer): ReactTestInstance | undefined {
    return byName(tree, 'Pressable').find(
      (node) => node.props.accessibilityLabel === 'Dismiss notice'
    )
  }

  it('serves the page and says the update did not happen, promising no retry', async () => {
    dependencies.updateNotice = 'update-failed'
    const tree = await renderScreen(readyState('session-one'))
    expect(byName(tree, 'ShellViewProbe')).toHaveLength(1)
    const text = textOf(tree)
    expect(text).toContain("Couldn't update the workspace from this host")
    expect(text).toContain('Showing the last version that worked')
    expect(text).not.toContain('Try again')
  })

  it('carries the notice to a reader who never arrives at the top of the page', async () => {
    // The banner is inserted into a screen already on screen. Assertive because the shell passes
    // the failure tone: what it reports is an update that did not happen.
    dependencies.updateNotice = 'update-failed'
    const tree = await renderScreen(readyState('session-one'))
    const alert = byName(tree, 'View').find((node) => node.props.accessibilityRole === 'alert')
    expect(alert).toBeDefined()
    expect(alert?.props.accessibilityLiveRegion).toBe('assertive')
  })

  it('says nothing when the generation on screen is the one the host serves', async () => {
    const tree = await renderScreen(readyState('session-one'))
    expect(dismissControl(tree)).toBeUndefined()
    expect(textOf(tree)).not.toContain("Couldn't update")
  })

  it('keeps the same document mounted when the notice is dismissed', async () => {
    dependencies.updateNotice = 'update-failed'
    const tree = await renderScreen(readyState('session-one'))
    dependencies.lifecycle.length = 0
    await act(async () => {
      dismissControl(tree)?.props.onPress()
    })
    expect(dismissControl(tree)).toBeUndefined()
    expect(textOf(tree)).not.toContain("Couldn't update")
    // The page is the point: a notice that reloaded the workspace to get out of the way would
    // cost the user exactly what the fallback was for.
    expect(byName(tree, 'ShellViewProbe')).toHaveLength(1)
    expect(dependencies.lifecycle).toEqual([])
  })

  it('shows a later refusal rather than staying dismissed for the rest of the host', async () => {
    dependencies.updateNotice = 'update-failed'
    const tree = await renderScreen(readyState('session-one'))
    await act(async () => {
      dismissControl(tree)?.props.onPress()
    })
    // The next flow refused too, and opened its own fallback: a new document, so the tap on the
    // one before it is not an answer about this one.
    await updateScreen(tree, readyState('session-two'))
    expect(dismissControl(tree)).toBeDefined()
  })
})

/**
 * Last in the file on purpose: it is the case the block above would have poisoned.
 *
 * Those cases grant the screencast lane and install a client, and before the shared setup reset
 * them both, whatever ran next inherited a route granted a lane it never asked for. Deleting the
 * reset fails here and nowhere else, because nothing else runs after a case that mutates them.
 */
describe('what one case mutates does not reach the next', () => {
  it('starts from the shared route grants and no client', () => {
    expect({ grants: dependencies.routeGrants, client: dependencies.client }).toEqual({
      grants: DEFAULT_ROUTE_GRANTS,
      client: null
    })
  })

  it('shortens the view by the keyboard, which is the only side that can see one', async () => {
    // Edge-to-edge makes the manifest's `adjustResize` inert, so the window never shrinks and the
    // page's `visualViewport` reads full height with the IME up: it lays its live input row out
    // under the keys. The shell owns the window, so it takes the strip off the view instead.
    const tree = await renderScreen(readyState('session-keyboard'))
    const root = tree.root.find((node) => node.props.testID === 'mobile-web-shell-ready')
    expect(root.props.style[1]).toEqual({ paddingTop: 44, paddingBottom: 8 })

    await act(async () => {
      dependencies.keyboardListeners.get('keyboardWillShow')?.({ endCoordinates: { height: 336 } })
    })
    expect(root.props.style[1]).toEqual({ paddingTop: 44, paddingBottom: 336 })

    await act(async () => {
      dependencies.keyboardListeners.get('keyboardWillHide')?.({ endCoordinates: { height: 0 } })
    })
    expect(root.props.style[1]).toEqual({ paddingTop: 44, paddingBottom: 8 })
  })
})

/**
 * What is on screen between the generation being mounted and the page having a frame.
 *
 * Before this the answer was nothing: the shell tore its own frame down at `ready` and the WebView
 * draws nothing until its document paints, so the surface behind it was the whole picture for the
 * length of the page's boot — measured at 1.42 s on a cached generation.
 */
describe('the frame under a page that has not painted', () => {
  it('keeps the shell frame over a mounted view, with the view underneath it', async () => {
    dependencies.pageFrame = 'unpainted'
    const tree = await renderScreen(readyState('session-a'))
    expect(
      tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-cover')
    ).toHaveLength(1)
    // Over, not instead of: the document is loading the whole time the cover is up.
    expect(byName(tree, 'ShellViewProbe')).toHaveLength(1)
    expect(textOf(tree)).toContain('Opening workspace')
  })

  it('carries the same label the screen was already painting while it opened the generation', async () => {
    const opening = await renderScreen({ kind: 'activating' })
    expect(textOf(opening)).toContain('Opening workspace')
    dependencies.pageFrame = 'unpainted'
    await updateScreen(opening, readyState('session-a'))
    // The frame does not change when the state does, which is what makes the handover invisible.
    expect(textOf(opening)).toContain('Opening workspace')
  })

  it('takes the frame down once the page reports one of its own', async () => {
    dependencies.pageFrame = 'unpainted'
    const tree = await renderScreen(readyState('session-a'))
    dependencies.pageFrame = 'painted'
    await updateScreen(tree, readyState('session-a'))
    expect(tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-cover')).toEqual([])
  })

  it('covers the same box the view gets, which is what the keyboard strip shortens', async () => {
    // Both are children of the padded root: the view is `flex: 1` and the cover is an absolute
    // fill, so Yoga lays each of them out against the same content box. The keyboard takes its
    // strip off that box, so it takes it off both, and the cover cannot leave a gap the view fills.
    dependencies.pageFrame = 'unpainted'
    const tree = await renderScreen(readyState('session-keyboard-cover'))
    const root = tree.root.find((node) => node.props.testID === 'mobile-web-shell-ready')
    await act(async () => {
      dependencies.keyboardListeners.get('keyboardWillShow')?.({ endCoordinates: { height: 336 } })
    })
    expect(root.props.style[1]).toEqual({ paddingTop: 44, paddingBottom: 336 })
    const cover = tree.root.find((node) => node.props.testID === 'mobile-web-shell-cover')
    expect(cover.props.style[0]).toMatchObject({
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0
    })
    // Both sit directly in that root with no box in between, so neither carries a padding of its
    // own for the two to disagree about.
    expect(hostParentOf(cover)).toBe('mobile-web-shell-ready')
    expect(hostParentOf(byName(tree, 'ShellViewProbe')[0])).toBe('mobile-web-shell-ready')
  })

  it('hands the page report to the session', async () => {
    dependencies.pageFrame = 'unpainted'
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState('session-a'))
    const probe = byName(tree, 'ShellViewProbe')[0]
    await act(async () => {
      probe.props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready', reports: [BRIDGE_PAGE_PAINTED] }) }
      })
    })
    expect(dependencies.reportPageReady).toHaveBeenCalledWith([BRIDGE_PAGE_PAINTED])
    await act(async () => {
      probe.props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'notify', name: BRIDGE_PAGE_PAINTED }) }
      })
    })
    expect(dependencies.reportPagePainted).toHaveBeenCalledTimes(1)
  })
})
