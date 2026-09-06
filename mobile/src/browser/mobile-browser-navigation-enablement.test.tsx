import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserScreencastFrame } from '../transport/browser-screencast-protocol'
import { MobileBrowserPane, type MobileBrowserTab } from './MobileBrowserPane'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
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

let pageCounter = 0

function browserTab(navigation: { canGoBack: boolean; canGoForward: boolean }): MobileBrowserTab {
  return {
    type: 'browser',
    id: `tab-${pageCounter}`,
    title: 'Dashboard',
    browserWorkspaceId: 'bw-1',
    browserPageId: `page-${pageCounter}`,
    url: 'https://dashboard.example',
    loading: false,
    isActive: true,
    ...navigation
  }
}

function backButtonDisabled(renderer: ReactTestRenderer): boolean {
  const back = renderer.root
    .findAllByType('Pressable')
    .find((node) => node.props.accessibilityLabel === 'Back')
  if (!back) {
    throw new Error('Back control not found')
  }
  return back.props.disabled === true
}

async function renderPane(navigation: { canGoBack: boolean; canGoForward: boolean }): Promise<{
  renderer: ReactTestRenderer
  emit: (payload: unknown) => void
  update: (next: { canGoBack: boolean; canGoForward: boolean }) => Promise<void>
}> {
  pageCounter += 1
  let listener: ((payload: unknown) => void) | null = null
  const operations = {
    subscribe: (
      _target: unknown,
      _request: unknown,
      handlers: {
        onEvent: (payload: unknown) => void
        onFrame?: (frame: BrowserScreencastFrame) => void
      }
    ) => {
      listener = handlers.onEvent
      return () => {}
    },
    request: vi.fn()
  }
  const worktreeId = `wt-${pageCounter}`
  const props = (tab: MobileBrowserTab) => ({
    operations,
    worktreeId,
    tab,
    screencastSupported: true,
    keyboardLift: 0,
    bottomInset: 0,
    onToast: () => {}
  })

  let renderer: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(MobileBrowserPane, props(browserTab(navigation))), {
      createNodeMock: () => ({ setNativeProps: () => {} })
    })
    await Promise.resolve()
  })
  const mounted: ReactTestRenderer = renderer!
  const viewport = mounted.root
    .findAllByType('View')
    .find((node) => typeof node.props.onLayout === 'function')
  if (!viewport) {
    throw new Error('Viewport with onLayout not found')
  }
  act(() => {
    viewport.props.onLayout({ nativeEvent: { layout: { width: 360, height: 640 } } })
  })
  if (!listener) {
    throw new Error('browser.screencast subscription not created')
  }
  return {
    renderer: mounted,
    emit: (payload) => act(() => listener?.(payload)),
    update: async (next) => {
      await act(async () => {
        mounted.update(createElement(MobileBrowserPane, props(browserTab(next))))
        await Promise.resolve()
      })
    }
  }
}

describe('MobileBrowserPane navigation enablement', () => {
  it('keeps Back enabled from the tab props against a host that never reports navigation', async () => {
    const { renderer, emit } = await renderPane({ canGoBack: true, canGoForward: false })

    expect(backButtonDisabled(renderer)).toBe(false)

    // An older host emits `ready` without the navigation flags and no `navigation` event.
    emit({ type: 'ready', tab: { url: 'https://dashboard.example' } })

    expect(backButtonDisabled(renderer)).toBe(false)
  })

  it('accepts a newer host navigation event as a refinement between tab updates', async () => {
    const { renderer, emit } = await renderPane({ canGoBack: true, canGoForward: false })

    emit({
      type: 'navigation',
      tab: { url: 'https://dashboard.example/start', canGoBack: false, canGoForward: false }
    })

    expect(backButtonDisabled(renderer)).toBe(true)
  })

  it('follows the tab props when an older host republishes navigability', async () => {
    const { renderer, emit, update } = await renderPane({ canGoBack: false, canGoForward: false })

    expect(backButtonDisabled(renderer)).toBe(true)
    emit({ type: 'ready', tab: { url: 'https://dashboard.example' } })

    // Without a `navigation` event, the republished tab is the only signal there is.
    await update({ canGoBack: true, canGoForward: false })
    expect(backButtonDisabled(renderer)).toBe(false)
  })
})
