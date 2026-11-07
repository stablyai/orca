import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBrowserDrawing } from '../storage/preferences'
import { MobileLocalBrowser } from './MobileLocalBrowser'
import { MobileLocalBrowserPane } from './MobileLocalBrowserPane'
import { useMobileBrowserLocalTunnel } from './use-mobile-browser-local-tunnel'

vi.mock('../storage/preferences', () => ({ loadBrowserDrawing: vi.fn() }))
vi.mock('./mobile-browser-local-proxy', () => ({
  PHONE_NETWORK_BROWSER_STORE_ID: 'phone-store'
}))
vi.mock('./MobileLocalBrowserPane', () => ({
  MobileLocalBrowserPane: () => null
}))
vi.mock('./use-mobile-browser-local-tunnel', () => ({
  useMobileBrowserLocalTunnel: vi.fn()
}))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

async function mount(onHostTunnelFailed = vi.fn()): Promise<void> {
  await act(async () => {
    renderer = create(
      createElement(MobileLocalBrowser, {
        client: null,
        hostId: 'host-a',
        worktreeId: 'wt-1',
        initialUrl: 'https://example.com/',
        initialViewMode: 'mobile',
        fullScreen: null,
        pending: null,
        onStreamFromHost: vi.fn(),
        onHostTunnelFailed,
        onToast: vi.fn()
      })
    )
  })
}

function pane() {
  return renderer.root.findByType(MobileLocalBrowserPane)
}

function tunnelEnabledCalls(): boolean[] {
  return vi.mocked(useMobileBrowserLocalTunnel).mock.calls.map((call) => call[3])
}

describe('MobileLocalBrowser', () => {
  it('opens on the phone network from the setting without starting the host tunnel', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('phone')
    vi.mocked(useMobileBrowserLocalTunnel).mockReturnValue({
      status: 'unavailable'
    })
    await mount()
    expect(pane().props).toMatchObject({
      network: 'phone',
      storeId: 'phone-store'
    })
    expect(tunnelEnabledCalls()).not.toContain(true)
  })

  it('reopens the current page when switching to the host network', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('phone')
    vi.mocked(useMobileBrowserLocalTunnel).mockImplementation((_c, _h, _w, enabled) =>
      enabled
        ? { status: 'ready', proxyKey: 'host-a', storeId: 'host-store' }
        : { status: 'unavailable' }
    )
    await mount()
    act(() => pane().props.onUrlChange('https://example.com/next'))
    act(() => pane().props.onNetworkChange('host'))
    expect(pane().props).toMatchObject({
      network: 'host',
      proxyKey: 'host-a',
      storeId: 'host-store',
      initialUrl: 'https://example.com/next'
    })
  })

  it('draws a tab set to stream through the host when it is asked to draw it', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('stream')
    vi.mocked(useMobileBrowserLocalTunnel).mockReturnValue({
      status: 'ready',
      proxyKey: 'host-a',
      storeId: 'host-store'
    })
    await mount()
    expect(pane().props).toMatchObject({ network: 'host', proxyKey: 'host-a' })
  })

  it('reopens the current page in the other site layout', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('phone')
    vi.mocked(useMobileBrowserLocalTunnel).mockReturnValue({ status: 'unavailable' })
    await mount()
    act(() => pane().props.onUrlChange('https://example.com/next'))
    act(() => pane().props.onViewModeChange('web'))
    expect(pane().props).toMatchObject({
      viewMode: 'web',
      initialUrl: 'https://example.com/next'
    })
  })

  it('reports a failed host tunnel', async () => {
    vi.mocked(loadBrowserDrawing).mockResolvedValue('host')
    vi.mocked(useMobileBrowserLocalTunnel).mockReturnValue({
      status: 'failed',
      message: 'denied'
    })
    const onHostTunnelFailed = vi.fn()
    await mount(onHostTunnelFailed)
    expect(onHostTunnelFailed).toHaveBeenCalledWith('denied')
    expect(renderer.root.findAllByType(MobileLocalBrowserPane)).toHaveLength(0)
  })
})
