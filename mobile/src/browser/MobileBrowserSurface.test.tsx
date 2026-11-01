import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileBrowserFullScreenFrame } from './MobileBrowserFullScreenFrame'
import { MobileBrowserPane } from './MobileBrowserPane'
import { MobileBrowserPlacedLocal } from './MobileBrowserPlacedLocal'
import { MobileBrowserSurface } from './MobileBrowserSurface'

vi.mock('react-native', () => ({ View: 'View' }))
vi.mock('../i18n/mobile-i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../storage/preferences', () => ({ loadBrowserDrawing: vi.fn() }))
vi.mock('./mobile-browser-pane-styles', () => ({ mobileBrowserPaneStyles: { root: {} } }))
vi.mock('./mobile-browser-view-mode-state', () => ({
  getInitialMobileBrowserViewMode: () => 'mobile',
  saveMobileBrowserViewMode: () => {}
}))
vi.mock('./use-mobile-browser-local-tunnel', () => ({
  canRenderBrowserLocally: () => false,
  useMobileBrowserLocalTunnel: () => ({ status: 'unavailable' })
}))
vi.mock('../platform/shell-local-browser', () => ({
  useShellLocalBrowser: () => ({
    openFullScreen: null,
    placed: { show: vi.fn(), move: vi.fn(), remove: vi.fn() }
  })
}))
vi.mock('./MobileBrowserPane', () => ({ MobileBrowserPane: () => null }))
vi.mock('./MobileBrowserPlacedLocal', () => ({ MobileBrowserPlacedLocal: () => null }))
vi.mock('./MobileLocalBrowser', () => ({ MobileLocalBrowser: () => null }))
vi.mock('./MobileBrowserFullScreenFrame', () => ({
  MobileBrowserFullScreenFrame: ({ children }: { children: React.ReactNode }) => children
}))

let renderer: ReactTestRenderer

const TAB = {
  type: 'browser' as const,
  id: 'tab-1',
  title: 'Example',
  browserWorkspaceId: 'bw-1',
  browserPageId: 'page-1',
  url: 'https://example.com/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

beforeEach(() => {
  act(() => {
    renderer = create(
      createElement(MobileBrowserSurface, {
        hostId: 'host-a',
        client: null,
        worktreeId: 'wt-1',
        tab: TAB,
        screencastSupported: true,
        keyboardLift: 0,
        bottomInset: 0,
        onToast: () => {}
      })
    )
  })
})

afterEach(() => {
  act(() => renderer.unmount())
})

const placedView = () => renderer.root.findAllByType(MobileBrowserPlacedLocal)
const streamedPane = () => renderer.root.findByType(MobileBrowserPane)
const fullScreenFrames = () => renderer.root.findAllByType(MobileBrowserFullScreenFrame)

describe('a served tab the app shell draws', () => {
  it('stays full screen when the user streams it from the shell full screen', () => {
    act(() => placedView()[0]!.props.onEnded('streamedFullScreen'))

    expect(fullScreenFrames()).toHaveLength(1)
    expect(streamedPane().props.drawing.fullScreen.active).toBe(true)
  })

  it('offers drawing on the phone again once streamed, on the network the user picks', () => {
    act(() => placedView()[0]!.props.onEnded('streamed'))
    expect(fullScreenFrames()).toHaveLength(0)

    act(() => streamedPane().props.drawing.onDrawingChange('phone'))

    expect(placedView()[0]!.props).toMatchObject({ network: 'phone', fullScreen: false })
  })

  it('asks the shell for full screen when the user picks drawing from a full-screen stream', () => {
    act(() => placedView()[0]!.props.onEnded('streamed'))
    act(() => streamedPane().props.drawing.fullScreen.onToggle())
    expect(fullScreenFrames()).toHaveLength(1)

    act(() => streamedPane().props.drawing.onDrawingChange('host'))

    expect(fullScreenFrames()).toHaveLength(0)
    expect(placedView()[0]!.props).toMatchObject({ network: 'host', fullScreen: true })
  })
})
