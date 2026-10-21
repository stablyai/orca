// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { AppBackgroundScope } from '../../../shared/app-background-settings'
import { AppBackgroundLayer } from '../components/app-background/AppBackgroundLayer'
import { useAppStore } from '../store'
import { useScopedAppBackground } from './use-app-background-appearance'

const IMAGE_ID = '11111111-1111-4111-8111-111111111111.png'
const initialState = useAppStore.getState()

// Mirrors how App.tsx (window) and AppWorkspaceShell.tsx (workspace) wire a host.
function Host({ scope }: { scope: AppBackgroundScope }): React.JSX.Element {
  const background = useScopedAppBackground(scope)
  return (
    <div
      data-testid={`host-${scope}`}
      className="host"
      data-app-background={background?.host['data-app-background']}
      style={background?.host.style}
    >
      {background ? <AppBackgroundLayer {...background.layer} /> : null}
      <span>content</span>
    </div>
  )
}

function renderHosts(): ReturnType<typeof render> {
  return render(
    <>
      <Host scope="window" />
      <Host scope="workspace" />
    </>
  )
}

function setSettings(overrides: Partial<GlobalSettings>): void {
  useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), ...overrides } })
}

describe('useScopedAppBackground hosts', () => {
  const read = vi.fn()

  beforeEach(() => {
    read.mockReset().mockResolvedValue(new ArrayBuffer(8))
    vi.stubGlobal('api', { ...window.api, appBackground: { read } })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:background')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useAppStore.setState(initialState, true)
  })

  it('leaves both hosts byte-identical to unwired markup without an image', () => {
    setSettings({ appBackgroundImageId: null, appBackgroundScope: 'window' })
    const { getByTestId } = renderHosts()

    for (const scope of ['window', 'workspace']) {
      expect(getByTestId(`host-${scope}`).outerHTML).toBe(
        `<div data-testid="host-${scope}" class="host"><span>content</span></div>`
      )
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('marks only the window host and paints the layer for window scope', async () => {
    setSettings({
      appBackgroundImageId: IMAGE_ID,
      appBackgroundScope: 'window',
      appBackgroundPanelOpacity: 0.5,
      appBackgroundImageOpacity: 0.4,
      appBackgroundBlur: 3
    })
    const { getByTestId } = renderHosts()
    const host = getByTestId('host-window')

    await waitFor(() => expect(host.getAttribute('data-app-background')).toBe('window'))
    expect(host.style.getPropertyValue('--app-panel-opacity')).toBe('0.5')
    expect(getByTestId('host-workspace').hasAttribute('data-app-background')).toBe(false)

    const layer = await waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-testid="app-background-layer"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(layer.style.backgroundImage).toContain('blob:background')
    expect(layer.style.opacity).toBe('0.4')
    expect(layer.style.filter).toBe('blur(3px)')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(read).toHaveBeenCalledWith({ id: IMAGE_ID, staging: false })
  })

  it('marks only the workspace host for workspace scope', async () => {
    setSettings({ appBackgroundImageId: IMAGE_ID, appBackgroundScope: 'workspace' })
    const { getByTestId } = renderHosts()

    expect(getByTestId('host-window').hasAttribute('data-app-background')).toBe(false)
    const host = getByTestId('host-workspace')
    await waitFor(() => expect(host.getAttribute('data-app-background')).toBe('workspace'))
    expect(host.style.getPropertyValue('--app-panel-opacity')).toBe('0.8')
    await waitFor(() =>
      expect(host.querySelector('[data-testid="app-background-layer"]')).not.toBeNull()
    )
  })

  it('keeps panels opaque until the image bytes arrive', async () => {
    let resolveRead: (bytes: ArrayBuffer | null) => void = () => {}
    read.mockReturnValue(
      new Promise<ArrayBuffer | null>((resolve) => {
        resolveRead = resolve
      })
    )
    setSettings({ appBackgroundImageId: IMAGE_ID, appBackgroundScope: 'window' })
    const { getByTestId } = renderHosts()
    const host = getByTestId('host-window')

    expect(host.hasAttribute('data-app-background')).toBe(false)
    expect(host.style.getPropertyValue('--app-panel-opacity')).toBe('')

    await act(async () => {
      resolveRead(new ArrayBuffer(8))
    })
    await waitFor(() => expect(host.getAttribute('data-app-background')).toBe('window'))
  })

  it('stays opaque when the saved image cannot be read', async () => {
    read.mockResolvedValue(null)
    setSettings({ appBackgroundImageId: IMAGE_ID, appBackgroundScope: 'window' })
    const { getByTestId } = renderHosts()
    const host = getByTestId('host-window')

    await waitFor(() => expect(read).toHaveBeenCalled())
    await act(async () => {})

    expect(host.hasAttribute('data-app-background')).toBe(false)
    expect(host.querySelector('[data-testid="app-background-layer"]')).toBeNull()
  })

  it('renders nothing on the web client', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    setSettings({ appBackgroundImageId: IMAGE_ID, appBackgroundScope: 'window' })
    const { getByTestId } = renderHosts()

    expect(getByTestId('host-window').hasAttribute('data-app-background')).toBe(false)
    expect(getByTestId('host-window').querySelector('.app-background-layer')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('drops the host attribute and revokes the blob when the image is removed', async () => {
    setSettings({ appBackgroundImageId: IMAGE_ID, appBackgroundScope: 'window' })
    const { getByTestId } = renderHosts()
    const host = getByTestId('host-window')
    await waitFor(() =>
      expect(host.querySelector('[data-testid="app-background-layer"]')).not.toBeNull()
    )

    act(() => {
      setSettings({ appBackgroundImageId: null, appBackgroundScope: 'window' })
    })

    expect(host.hasAttribute('data-app-background')).toBe(false)
    expect(host.querySelector('[data-testid="app-background-layer"]')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:background')
  })
})
