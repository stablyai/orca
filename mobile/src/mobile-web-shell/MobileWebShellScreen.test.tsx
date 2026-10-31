import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())

const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))
vi.mock('react-native', mocks['react-native'])
vi.mock('expo-clipboard', mocks['expo-clipboard'])
vi.mock('expo-haptics', mocks['expo-haptics'])
vi.mock('expo-document-picker', mocks['expo-document-picker'])
vi.mock('@orca/expo-two-way-audio', mocks['@orca/expo-two-way-audio'])
vi.mock('expo-keep-awake', mocks['expo-keep-awake'])
vi.mock('expo-image-picker', mocks['expo-image-picker'])
vi.mock('expo-file-system', mocks['expo-file-system'])
vi.mock('lucide-react-native', mocks['lucide-react-native'])
vi.mock('react-native-safe-area-context', mocks['react-native-safe-area-context'])
vi.mock('expo-router', mocks['expo-router'])
vi.mock('../../modules/orca-mobile-web-shell/src', mocks['../../modules/orca-mobile-web-shell/src'])
vi.mock('../app-update/use-wall-app-update', mocks['../app-update/use-wall-app-update'])
vi.mock('../transport/host-client-hooks', mocks['../transport/host-client-hooks'])
vi.mock('./use-page-host-snapshot', mocks['./use-page-host-snapshot'])
vi.mock('./use-mobile-web-shell-session', mocks['./use-mobile-web-shell-session'])

import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { bridgeId, clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import {
  byName,
  trackRenderedScreen,
  SCREEN_BUILD_ID as BUILD_ID,
  SCREEN_DIRECTORY as DIRECTORY,
  hostParentOf,
  readyState,
  renderScreen as mountScreen,
  textOf,
  updateScreen as reRenderScreen
} from './mobile-web-shell-screen-test-harness'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge/bridge-page-back'
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  readBridgeHostMessage
} from './bridge/bridge-envelope'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import { connectionLogStore } from '../transport/persisted-connection-log-store'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'

const fetching = (receivedBytes: number, totalBytes: number): MobileWebShellSessionState => ({
  kind: 'fetching',
  completedAssets: 0,
  totalAssets: 128,
  receivedBytes,
  totalBytes
})

function fillScaleOf(tree: ReactTestRenderer): unknown {
  return fillOf(tree).value
}

function fillOf(tree: ReactTestRenderer): { readonly value: unknown } {
  const bar = tree.root.find(
    (node) => node.props.testID === 'mobile-web-shell-progress-bar' && String(node.type) === 'View'
  )
  const [fill] = bar.findAll((node) => String(node.type) === 'Animated.View')
  return fill.props.style[1].transform[0].scaleX
}

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
    expect(textOf(tree)).toContain('The downloaded app could not be opened.')
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
      'Connect to this host to download the latest app'
    )
  })

  it('shows the download as a progress bar with megabytes from the paired host', async () => {
    const tree = await renderScreen({
      kind: 'fetching',
      completedAssets: 0,
      totalAssets: 128,
      receivedBytes: 2_020_592,
      totalBytes: 8_082_368
    })
    expect(textOf(tree)).toContain('Downloading the latest app')
    expect(textOf(tree)).toContain('from Host One · 2.0 of 8.1 MB')
    const bar = tree.root.findAll(
      (node) =>
        node.props.testID === 'mobile-web-shell-progress-bar' && String(node.type) === 'View'
    )
    expect(bar).toHaveLength(1)
    expect(bar[0].props.accessibilityRole).toBe('progressbar')
    expect(bar[0].props.accessibilityValue).toEqual({ min: 0, max: 100, now: 25 })
    expect(fillScaleOf(tree)).toBe(0.25)
    expect(byName(tree, 'ActivityIndicator')).toEqual([])
  })

  it('moves the fill with the download feed, without a render to carry it', async () => {
    const tree = await renderScreen(fetching(2_020_592, 8_082_368))
    expect(fillScaleOf(tree)).toBe(0.25)
    dependencies.downloadProgress.publish(0.5)
    expect(fillScaleOf(tree)).toBe(0.5)
    expect(textOf(tree)).toContain('2.0 of 8.1 MB')
  })

  it('starts one ease per window toward the latest value, and lands full at once', async () => {
    const tree = await renderScreen(fetching(0, 8_082_368))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      dependencies.downloadProgress.publish(0.1)
      dependencies.downloadProgress.publish(0.2)
      dependencies.downloadProgress.publish(0.3)
      expect(fillScaleOf(tree)).toBe(0.1)
      vi.advanceTimersByTime(50)
      expect(fillScaleOf(tree)).toBe(0.3)
      dependencies.downloadProgress.publish(0.4)
      dependencies.downloadProgress.publish(1)
      expect(fillScaleOf(tree)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts nothing after unmount for a value still waiting on its window', async () => {
    const tree = await renderScreen(fetching(0, 8_082_368))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      dependencies.downloadProgress.publish(0.1)
      dependencies.downloadProgress.publish(0.5)
      const fill = fillOf(tree)
      act(() => tree.unmount())
      vi.advanceTimersByTime(50)
      expect(fill.value).toBe(0.1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the bar at full when more bytes arrive than the total named', async () => {
    const tree = await renderScreen(fetching(9_000_000, 8_082_368))
    expect(fillScaleOf(tree)).toBe(1)
  })

  it('reads an empty download as no progress rather than dividing by zero', async () => {
    const tree = await renderScreen({
      kind: 'fetching',
      completedAssets: 0,
      totalAssets: 0,
      receivedBytes: 0,
      totalBytes: 0
    })
    const bar = tree.root.findAll(
      (node) =>
        node.props.testID === 'mobile-web-shell-progress-bar' && String(node.type) === 'View'
    )
    expect(bar[0].props.accessibilityValue).toEqual({ min: 0, max: 100, now: 0 })
    expect(fillScaleOf(tree)).toBe(0)
    expect(textOf(tree)).toContain('0.0 of 0.0 MB')
  })

  it('hands the shell view the generation path and the session id', async () => {
    const tree = await renderScreen(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    expect(view.props.generationDirectory).toBe(DIRECTORY)
    expect(view.props.sessionId).toBe('session-one')
  })

  it('delivers an init through the ready view bridge', async () => {
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    expect(view.props.bridgeEnabled).toBe(true)
    await act(async () =>
      view.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
    )
    expect(dependencies.posted.map((raw) => readBridgeHostMessage(raw))).toContainEqual({
      ok: true,
      message: expect.objectContaining({
        type: 'init',
        sessionId: 'session-one',
        host: expect.objectContaining({ id: 'host-1' })
      })
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
    // Start the paint deadline only for completed documents; failed loads cannot produce a frame.
    expect(dependencies.reportDocumentLoaded).toHaveBeenCalledTimes(1)
    expect(dependencies.reportDocumentStarted).toHaveBeenCalledTimes(1)
  })

  it('fails the session when this host could not be read from the app store', async () => {
    // Profile failure must exit ready; otherwise the page keeps asking for init with no host behind it.
    dependencies.snapshotUnreadable = true
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logged = () => connectionLogStore.get('host-1').map((entry) => entry.message)
    const before = logged().length
    await renderScreen(readyState('session-one'))
    expect(dependencies.reportShellFailure.mock.calls).toEqual([['host-profile-unreadable']])
    expect(logged().slice(before)).toEqual(['Web shell: host profile unreadable'])
    warned.mockRestore()
  })

  it('requests an app-store refresh on every ready ask', async () => {
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState('session-one'))
    const view = byName(tree, 'ShellViewProbe')[0]
    const refreshesBeforeReady = dependencies.storageRefreshes
    await act(async () => {
      view.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
      view.props.onBridgeMessage({ nativeEvent: { json: clientFrame({ type: 'ready' }) } })
    })
    // A document that reloads inside one mount asks again; a refresh per ask is what lets a key
    // the app changed meanwhile reach the `init` after it.
    expect(dependencies.storageRefreshes - refreshesBeforeReady).toBe(2)
  })

  // Observe wire frames only; ruling 34 leaves delivery untracked and one-shot consumption to the page.
  async function renderForRoute(params: Record<string, string>): Promise<{
    tree: ReactTestRenderer
    initRoutes: () => (Record<string, string> | undefined)[]
    move: (next: Record<string, string>) => Promise<void>
    ready: () => Promise<void>
  }> {
    const element = (next: Record<string, string>) =>
      createElement(MobileWebShellScreen, {
        hostId: 'host-1',
        route: { pathname: '/h/host-1', params: next }
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
      // Parse with the page’s reader so rejected frames cannot inflate init counts.
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
      ready: async () => {
        await act(async () => {
          byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
            nativeEvent: { json: clientFrame({ type: 'ready' }) }
          })
        })
      }
    }
  }

  // Send once per route change; the next ready repairs missed delivery using the current route, without tracking acknowledgements (rulings 33.1/34).
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
    expect(dependencies.posted).toHaveLength(2)
    dependencies.postFails = false
    await page.ready()
    expect(page.initRoutes().at(-1)).toEqual({ paneKey: 'pane-1' })
    warned.mockRestore()
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

  // Client replacement rebuilds the host without changing the page session; seed it from reducer state because the page does not handshake again.
  it('serves a page whose session handshook before this host was built', async () => {
    const client = createFakeRpcClient()
    dependencies.client = client
    dependencies.pageReady = true
    const tree = await renderScreen(readyState('session-one'))
    // No new ready arrives from a page that was never told its host changed.
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({ type: 'request', id: bridgeId(1), method: 'status.get' })
        }
      })
    })
    expect(client.requests.map((request) => request.method)).toEqual(['status.get'])
  })

  it('reports a ready page fault as a document-load failure', async () => {
    dependencies.client = createFakeRpcClient()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await renderScreen(readyState('session-one'))
    await act(async () => {
      // Only an established session receives the fault grant.
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
  })

  it('reports a URL nothing on this phone could open, which is the dead tap that survives', async () => {
    dependencies.client = createFakeRpcClient()
    const failure = new Error('no activity found')
    // Create rejection per call; constructing it before the frame arrives would leave it temporarily unhandled.
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
    // Notify has no reply, so only diagnostics reveal that the device failed to open the link.
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

  // This file pins iOS swipe interception; use-shell-page-back.test.tsx covers platform key selection.
  it('carries the page taking the device Back key up to the session', async () => {
    dependencies.client = createFakeRpcClient()
    const tree = await renderScreen(readyState('session-one'))
    await act(async () => {
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
      byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
        nativeEvent: {
          json: clientFrame({ type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed: true })
        }
      })
    })
    expect(dependencies.reportPageBackClaim).toHaveBeenCalledWith(true)
  })

  it('takes the stack swipe away while the session says the page is holding the key', async () => {
    dependencies.backClaimed = true
    await renderScreen(readyState('session-one'))
    expect(dependencies.setScreenOptions).toHaveBeenCalledWith({ gestureEnabled: false })
  })

  it('leaves the swipe alone while the page is holding nothing', async () => {
    await renderScreen(readyState('session-one'))
    expect(dependencies.setScreenOptions).toHaveBeenCalledWith({ gestureEnabled: true })
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
    // Back notify has no reply; its log is the only evidence of failure.
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

describe('a route the page does not serve and no side can be blamed for', () => {
  it('paints the unavailable screen itself, with no view and no spinner', async () => {
    const tree = await renderScreen({ kind: 'route-unavailable' })
    expect(textOf(tree)).toContain('This workspace screen is not available on this host.')
    expect(byName(tree, 'ShellViewProbe')).toEqual([])
    expect(byName(tree, 'ActivityIndicator')).toEqual([])
  })
})

describe('the dropped-frame count on the dev facts line', () => {
  // 500,000 raw bytes exceed the frame cap once encoded.
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
    const emit = dependencies.client?.streams[0]?.emitBinary
    if (emit === undefined || emit === null) {
      throw new Error('binary subscription was never opened')
    }
    for (let index = 0; index < times; index += 1) {
      await act(async () => {
        emit({ ...oversized, seq: index + 1 })
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

  // Dev facts render null in release; their updates must not rerender the screen at screencast frequency.
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

// Keep update refusal separate from the working fallback document; dismissing its notice must not reload that document.
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
    expect(text).toContain("Couldn't download the latest app from this host")
    expect(text).toContain('Showing the last version that worked')
    expect(text).not.toContain('Try again')
  })

  it('carries the notice to a reader who never arrives at the top of the page', async () => {
    // Use assertive failure announcement for an update refused after the screen was already visible.
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
      tree.root
        .find(
          (node) =>
            String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Dismiss notice'
        )
        .props.onPress()
    })
    expect(dismissControl(tree)).toBeUndefined()
    expect(textOf(tree)).not.toContain("Couldn't update")
    expect(byName(tree, 'ShellViewProbe')).toHaveLength(1)
    expect(dependencies.lifecycle).toEqual([])
  })

  it('shows a later refusal rather than staying dismissed for the rest of the host', async () => {
    dependencies.updateNotice = 'update-failed'
    const tree = await renderScreen(readyState('session-one'))
    await act(async () => {
      tree.root
        .find(
          (node) =>
            String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Dismiss notice'
        )
        .props.onPress()
    })
    // A new document’s refusal must not inherit the previous document’s dismissal.
    await updateScreen(tree, readyState('session-two'))
    expect(dismissControl(tree)).toBeDefined()
  })
})

// Keep a cover until first paint; uncovering at ready exposed bare surface during measured 1.42-second cached-page startup.
describe('the frame under a page that has not painted', () => {
  it('keeps the shell frame over a mounted view, with the view underneath it', async () => {
    dependencies.pageFrame = 'unpainted'
    const tree = await renderScreen(readyState('session-a'))
    expect(
      tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-cover')
    ).toHaveLength(1)
    // Keep the document mounted and loading under the cover.
    expect(byName(tree, 'ShellViewProbe')).toHaveLength(1)
    expect(textOf(tree)).toContain('Opening workspace')
  })

  it('carries the same label the screen was already painting while it opened the generation', async () => {
    const opening = await renderScreen({ kind: 'activating', source: 'cache' })
    expect(textOf(opening)).toContain('Opening workspace')
    dependencies.pageFrame = 'unpainted'
    await updateScreen(opening, readyState('session-a'))
    expect(textOf(opening)).toContain('Opening workspace')
  })

  it('takes the frame down once the page reports one of its own', async () => {
    dependencies.pageFrame = 'unpainted'
    const tree = await renderScreen(readyState('session-a'))
    dependencies.pageFrame = 'painted'
    await updateScreen(tree, readyState('session-a'))
    expect(tree.root.findAll((node) => node.props.testID === 'mobile-web-shell-cover')).toEqual([])
  })

  it('covers the same box the view gets, which the keyboard does not shorten', async () => {
    // View and absolute cover share the padded content box; keyboard overlays it rather than resizing it, so neither can expose an inset gap.
    dependencies.pageFrame = 'unpainted'
    const tree = await renderScreen(readyState('session-keyboard-cover'))
    const root = tree.root.find((node) => node.props.testID === 'mobile-web-shell-ready')
    await act(async () => {
      dependencies.keyboardListeners.get('keyboardWillShow')?.({ endCoordinates: { height: 336 } })
    })
    expect(root.props.style[1]).toEqual({ paddingTop: 0 })
    const cover = tree.root.find((node) => node.props.testID === 'mobile-web-shell-cover')
    expect(cover.props.style[0]).toMatchObject({
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0
    })
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
        nativeEvent: { json: clientFrame({ type: 'ready' }) }
      })
    })
    expect(dependencies.reportPageReady).toHaveBeenCalledTimes(1)
    await act(async () => {
      probe.props.onBridgeMessage({
        nativeEvent: { json: clientFrame({ type: 'notify', name: BRIDGE_PAGE_PAINTED }) }
      })
    })
    expect(dependencies.reportPagePainted).toHaveBeenCalledTimes(1)
  })
})
