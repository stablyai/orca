import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileBrowserPane, type MobileBrowserTab } from './MobileBrowserPane'

const appState = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
  emit(state: string) {
    for (const listener of appState.listeners) {
      listener(state)
    }
  }
}))

vi.mock('./use-browser-binary-screencast-grant', () => ({
  useBrowserBinaryScreencastGrant: () => true
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.add(listener)
      return { remove: () => appState.listeners.delete(listener) }
    }
  },
  Image: 'Image',
  PanResponder: { create: () => ({ panHandlers: {} }) },
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'android' },
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

type Subscription = { closed: boolean }

let pageCounter = 0
let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  appState.listeners.clear()
})

async function renderStreamingPane(): Promise<Subscription[]> {
  pageCounter += 1
  const subscriptions: Subscription[] = []
  const client: RpcClient = {
    sendRequest: vi.fn(),
    subscribe: () => {
      const subscription = { closed: false }
      subscriptions.push(subscription)
      return () => {
        subscription.closed = true
      }
    },
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  const tab: MobileBrowserTab = {
    type: 'browser',
    id: `tab-${pageCounter}`,
    title: 'Dashboard',
    browserWorkspaceId: 'bw-1',
    browserPageId: `page-${pageCounter}`,
    url: 'https://dashboard.example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: true
  }
  await act(async () => {
    renderer = create(
      createElement(MobileBrowserPane, {
        client,
        worktreeId: `wt-${pageCounter}`,
        tab,
        screencastSupported: true,
        keyboardLift: 0,
        bottomInset: 0,
        onToast: () => {}
      }),
      { createNodeMock: () => ({ setNativeProps: () => {} }) }
    )
    await Promise.resolve()
  })
  // Host components are strings under the react-native double.
  const hostView: string = 'View'
  const viewport = renderer?.root.find(
    (node) => node.type === hostView && typeof node.props.onLayout === 'function'
  )
  act(() => {
    viewport?.props.onLayout({ nativeEvent: { layout: { width: 360, height: 640 } } })
  })
  expect(subscriptions).toHaveLength(1)
  return subscriptions
}

function openStreams(subscriptions: Subscription[]): number {
  return subscriptions.filter((subscription) => !subscription.closed).length
}

describe('MobileBrowserPane across leaving the app and coming back', () => {
  it('stops the stream in the background and starts a new one on return', async () => {
    const subscriptions = await renderStreamingPane()

    act(() => appState.emit('background'))
    expect(openStreams(subscriptions)).toBe(0)

    act(() => appState.emit('active'))
    expect(subscriptions).toHaveLength(2)
    expect(openStreams(subscriptions)).toBe(1)
  })

  // Why: a quick leave and return can land in one React batch, which nets the two changes out.
  it('starts a new stream when the leave and the return land in one render', async () => {
    const subscriptions = await renderStreamingPane()

    act(() => {
      appState.emit('background')
      appState.emit('active')
    })

    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[0].closed).toBe(true)
    expect(openStreams(subscriptions)).toBe(1)
  })
})
