import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileLocalBrowser } from '../browser/MobileLocalBrowser'
import { loadBrowserDrawing } from '../storage/preferences'
import { useNativeLocalBrowser } from './native-local-browser'

vi.mock('react-native', () => ({ View: 'View' }))
vi.mock('../theme/themed-styles', () => ({ themedStyleSheet: (make: () => unknown) => make() }))
vi.mock('../theme/mobile-theme', () => ({ colors: { bgBase: '#000' } }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../transport/host-client-hooks', () => ({ useHostClient: () => ({ client: {} }) }))
vi.mock('../browser/use-mobile-browser-local-tunnel', () => ({
  canRenderBrowserLocally: () => true
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

function show(id: string): Promise<unknown> {
  return shell.serveView({
    action: 'show',
    id,
    worktreeId: 'wt-1',
    url: 'https://example.com/',
    viewMode: 'mobile',
    frame: FRAME
  })
}

function drawn() {
  return renderer.root.findAllByType(MobileLocalBrowser)
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
    await expect(shown).resolves.toEqual({ ended: 'streamed' })
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
    await expect(first).resolves.toEqual({ ended: 'replaced' })
    await act(async () => {
      await shell.serveView({ action: 'hide', id: 'a' })
    })
    expect(drawn()).toHaveLength(1)
  })
})
