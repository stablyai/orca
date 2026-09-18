import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

type ScreenDependencies = {
  retry: Mock
  reportShellFailure: Mock
  openUrl: Mock
  lifecycle: string[]
  state: MobileWebShellSessionState
}

const dependencies = vi.hoisted((): ScreenDependencies => {
  // Before the module under test is imported, so its `__DEV__` guard is on and the developer facts
  // are reachable at all — they are the one thing here that must never grow a secret.
  Object.assign(globalThis, { __DEV__: true })
  return {
    retry: vi.fn(),
    reportShellFailure: vi.fn(),
    openUrl: vi.fn(),
    lifecycle: [],
    state: { kind: 'checking' }
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
vi.mock('expo-router', () => ({ router: { replace: vi.fn() } }))
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
vi.mock('../transport/client-context', () => ({ useHostClient: () => ({ client: null }) }))
vi.mock('./use-mobile-web-shell-session', () => ({
  useMobileWebShellSession: () => ({
    state: dependencies.state,
    retry: dependencies.retry,
    reportShellFailure: dependencies.reportShellFailure
  })
}))

import { MobileWebShellScreen } from './MobileWebShellScreen'

const BUILD_ID = 'a1b2c3d4e5f6'.repeat(5) + 'abcd'
const DIRECTORY = '/var/mobile/Containers/Data/Caches/mobile-web/deadbeef/generations/a1b2'

async function render(state: MobileWebShellSessionState): Promise<ReactTestRenderer> {
  dependencies.state = state
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(MobileWebShellScreen, { hostId: 'host-1' }))
  })
  if (rendered.tree === null) {
    throw new Error('screen did not render')
  }
  return rendered.tree
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
    tree.update(createElement(MobileWebShellScreen, { hostId: 'host-1' }))
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

describe('the hybrid shell screen', () => {
  beforeEach(() => {
    dependencies.retry.mockReset()
    dependencies.reportShellFailure.mockReset()
    dependencies.lifecycle.length = 0
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
