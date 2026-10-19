/**
 * The browser pane leaving a workspace inside the host-area page: its screencast stream must end on
 * the device's client while the bridge host, which outlives the workspace there, stays up.
 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { MobileBrowserPane, type MobileBrowserTab } from './MobileBrowserPane'

vi.mock('./use-browser-binary-screencast-grant', () => ({
  useBrowserBinaryScreencastGrant: vi.fn(() => true)
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  PanResponder: { create: () => ({ panHandlers: {} }) },
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: {
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Monitor: 'Monitor',
  RefreshCw: 'RefreshCw',
  Smartphone: 'Smartphone'
}))

const TAB: MobileBrowserTab = {
  type: 'browser',
  id: 'tab-1',
  title: 'Docs',
  browserWorkspaceId: 'bw-1',
  browserPageId: 'page-1',
  url: 'https://docs.example/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

describe('the browser pane unmounting inside the host-area page', () => {
  it('ends its screencast stream, with the host left serving', async () => {
    const rpc = createFakeRpcClient()
    const pair = createBridgePortPair({
      rpc,
      route: { pathname: '/h/host-a' },
      routeGrants: ['screencastBinary'],
      ownsHostArea: true
    })
    await pair.flush()
    const mounted: { tree: ReactTestRenderer | null } = { tree: null }
    await act(async () => {
      mounted.tree = create(
        <MobileBrowserPane
          client={pair.client}
          worktreeId="worktree-1"
          tab={TAB}
          screencastSupported
          keyboardLift={0}
          bottomInset={0}
          onToast={() => {}}
        />,
        { createNodeMock: () => ({ setNativeProps: () => {} }) }
      )
    })
    const viewport = mounted.tree?.root.findAll(
      (node) => String(node.type) === 'View' && typeof node.props.onLayout === 'function'
    )[0]
    act(() => {
      viewport?.props.onLayout({ nativeEvent: { layout: { width: 402, height: 593 } } })
    })
    await pair.flush()
    const stream = rpc.streams.find((entry) => entry.method === 'browser.screencast')
    expect(stream?.unsubscribes).toBe(0)

    await act(async () => {
      mounted.tree?.unmount()
      await pair.flush()
    })
    expect(stream?.unsubscribes).toBe(1)
    // The document lives on: a later stream still opens through the same host.
    pair.client.subscribe('terminal.subscribe', { terminal: 'pty-1' }, () => {})
    await pair.flush()
    expect(rpc.streams.at(-1)?.method).toBe('terminal.subscribe')
  })
})
