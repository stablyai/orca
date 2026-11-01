import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileLocalBrowser } from '../browser/MobileLocalBrowser'
import { MobileLocalBrowserFullScreen } from '../browser/MobileLocalBrowserFullScreen'
import { loadBrowserDrawing } from '../storage/preferences'
import { useNativeLocalBrowser } from './native-local-browser'

vi.mock('react-native', () => ({ View: 'View' }))
vi.mock('../theme/themed-styles', () => ({ themedStyleSheet: (make: () => unknown) => make() }))
vi.mock('../theme/mobile-theme', () => ({ colors: { bgBase: '#000' } }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../transport/host-client-hooks', () => ({ useHostClient: () => ({ client: {} }) }))
const TUNNEL = { status: 'ready', proxyKey: 'proxy-1', storeId: 'store-1' }
vi.mock('../browser/use-mobile-browser-local-tunnel', () => ({
  canRenderBrowserLocally: () => true,
  useMobileBrowserLocalTunnel: () => TUNNEL
}))
vi.mock('../storage/preferences', () => ({ loadBrowserDrawing: vi.fn() }))
vi.mock('../browser/MobileLocalBrowser', () => ({ MobileLocalBrowser: () => null }))
vi.mock('../browser/MobileLocalBrowserFullScreen', () => ({
  MobileLocalBrowserFullScreen: () => null
}))
vi.mock('../browser/MobileLocalBrowserToast', () => ({ MobileLocalBrowserToast: () => null }))

let renderer: ReactTestRenderer
let shell: ReturnType<typeof useNativeLocalBrowser>

function Harness(): React.JSX.Element | null {
  shell = useNativeLocalBrowser('host-a', 'session-1')
  return shell.overlay
}

const FRAME = { x: 0, y: 40, width: 390, height: 600 }

function show(id: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return shell.serveView({
    action: 'show',
    id,
    worktreeId: 'wt-1',
    url: 'https://example.com/',
    viewMode: 'mobile',
    frame: FRAME,
    ...extra
  })
}

function drawn() {
  return renderer.root.findAllByType(MobileLocalBrowser)
}

function fullScreen() {
  return renderer.root.findAllByType(MobileLocalBrowserFullScreen)
}

beforeEach(() => {
  act(() => {
    renderer = create(createElement(Harness))
  })
})

afterEach(() => {
  act(() => renderer.unmount())
  vi.resetAllMocks()
})

describe('native.browser.view', () => {
  it('leaves the tab streamed when the browser settings stream tabs', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('stream')
    await expect(show('a')).resolves.toEqual({ ended: 'setting' })
    expect(drawn()).toHaveLength(0)
  })

  it('draws the tab over the pane until the user chooses streaming', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('phone')
    let shown: Promise<unknown> = Promise.resolve()
    await act(async () => {
      shown = show('a')
    })
    expect(drawn()).toHaveLength(1)
    act(() => drawn()[0]!.props.onStreamFromHost())
    await expect(shown).resolves.toEqual({ ended: 'streamed', viewMode: 'mobile' })
    expect(drawn()).toHaveLength(0)
  })

  it('draws nothing for a show the page hid while it was starting', async () => {
    let finishRead = (_drawing: 'host') => {}
    vi.mocked(loadBrowserDrawing).mockImplementation(
      () => new Promise((resolve) => (finishRead = resolve))
    )
    let shown: Promise<unknown> = Promise.resolve()
    await act(async () => {
      shown = show('a')
      await shell.serveView({ action: 'hide', id: 'a' })
      finishRead('host')
    })
    await expect(shown).resolves.toEqual({ ended: 'hidden' })
    expect(drawn()).toHaveLength(0)
  })

  it('opens at the place the page moved the pane to while the show was starting', async () => {
    let finishRead = (_drawing: 'host') => {}
    vi.mocked(loadBrowserDrawing).mockImplementation(
      () => new Promise((resolve) => (finishRead = resolve))
    )
    const moved = { x: 0, y: 120, width: 390, height: 520 }
    await act(async () => {
      void show('a')
      await shell.serveView({ action: 'move', id: 'a', frame: moved })
      finishRead('host')
    })
    expect(renderer.root.findByType('View').props.style).toContainEqual(
      expect.objectContaining({ top: 120, height: 520 })
    )
  })

  it('ignores a late hide from a pane another show replaced', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('host')
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = show('a')
    })
    await act(async () => {
      void show('b')
    })
    await expect(first).resolves.toEqual({ ended: 'replaced', viewMode: 'mobile' })
    await act(async () => {
      await shell.serveView({ action: 'hide', id: 'a' })
    })
    expect(drawn()).toHaveLength(1)
  })

  it('draws a tab the user picked on the page even when the browser settings stream tabs', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('stream')
    await act(async () => {
      void show('a', { network: 'phone' })
    })
    expect(drawn()[0]!.props.initialNetwork).toBe('phone')
  })

  it('opens full screen over the placed view, both on one tunnel, and keeps it when the user streams', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('host')
    let shown: Promise<unknown> = Promise.resolve()
    await act(async () => {
      shown = show('a', { fullScreen: true })
    })
    expect(fullScreen()).toHaveLength(1)
    expect(fullScreen()[0]!.props.tunnel).toBe(TUNNEL)
    expect(drawn()[0]!.props.tunnel).toBe(TUNNEL)
    act(() => fullScreen()[0]!.props.onStreamFromHost())
    await expect(shown).resolves.toEqual({ ended: 'streamedFullScreen', viewMode: 'mobile' })
    expect(fullScreen()).toHaveLength(0)
  })

  it('tells the page the layout the user left the view in, also from full screen', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('host')
    let shown: Promise<unknown> = Promise.resolve()
    await act(async () => {
      shown = show('a', { fullScreen: true })
    })
    act(() => fullScreen()[0]!.props.onViewModeChange('web'))
    act(() => fullScreen()[0]!.props.onStreamFromHost())
    await expect(shown).resolves.toEqual({ ended: 'streamedFullScreen', viewMode: 'web' })
  })

  it('opens the address the host reports on a view that is still blank', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('host')
    await act(async () => {
      void show('a', { url: 'about:blank' })
    })
    await act(async () => {
      await shell.serveView({ action: 'adopt', id: 'a', url: 'https://example.com/' })
    })
    expect(drawn()[0]!.props.initialUrl).toBe('https://example.com/')
  })

  it('leaves the page the user already went to when the host reports its address', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('host')
    await act(async () => {
      void show('a', { url: 'about:blank' })
    })
    act(() => drawn()[0]!.props.onUrlChange('https://user.example/'))
    await act(async () => {
      await shell.serveView({ action: 'adopt', id: 'a', url: 'https://example.com/' })
    })
    expect(drawn()[0]!.props.initialUrl).toBe('about:blank')
  })

  it('opens at the address the host reported while the show was starting', async () => {
    let finishRead = (_drawing: 'host') => {}
    vi.mocked(loadBrowserDrawing).mockImplementation(
      () => new Promise((resolve) => (finishRead = resolve))
    )
    await act(async () => {
      void show('a', { url: 'about:blank' })
      await shell.serveView({ action: 'adopt', id: 'a', url: 'https://example.com/' })
      finishRead('host')
    })
    expect(drawn()[0]!.props.initialUrl).toBe('https://example.com/')
  })
})
