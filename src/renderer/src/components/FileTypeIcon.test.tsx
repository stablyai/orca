// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { usePluginIconThemeStore } from '@/store/plugin-icon-themes'
import { FileTypeIcon } from './FileTypeIcon'
import { PluginIconSlot } from './PluginIconSlot'

afterEach(() => {
  usePluginIconThemeStore.setState({
    themes: [],
    activeId: null,
    activeTheme: null,
    loaded: true
  })
  document.body.innerHTML = ''
})

describe('FileTypeIcon', () => {
  it('renders sanitized plugin SVG data as an image and reacts to theme removal', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const dataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
    const activeTheme = {
      id: 'plugin:acme.icons/main' as const,
      pluginKey: 'acme.icons',
      label: 'Acme',
      icons: {},
      fileNames: {},
      fileExtensions: { ts: { dataUrl, rendering: 'image' as const } }
    }
    usePluginIconThemeStore.setState({
      activeId: 'plugin:acme.icons/main',
      activeTheme,
      loaded: true,
      themes: [activeTheme]
    })

    await act(async () => root.render(<FileTypeIcon filePath="src/index.ts" className="size-4" />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
    expect(container.querySelector('svg')).toBeNull()

    await act(async () => usePluginIconThemeStore.setState({ themes: [], activeTheme: null }))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()

    await act(async () => root.unmount())
  })

  it('renders host-defined plugin slots and falls back when the slot is absent', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const dataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
    const activeTheme = {
      id: 'plugin:acme.icons/main' as const,
      pluginKey: 'acme.icons',
      label: 'Acme',
      icons: { 'sidebar.search': { dataUrl, rendering: 'image' as const } },
      fileNames: {},
      fileExtensions: {}
    }
    usePluginIconThemeStore.setState({
      activeId: 'plugin:acme.icons/main',
      activeTheme,
      loaded: true,
      themes: [activeTheme]
    })

    await act(async () =>
      root.render(
        <PluginIconSlot
          slot="sidebar.search"
          fallback={<span data-fallback="true" />}
          className="size-4"
        />
      )
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(dataUrl)

    await act(async () =>
      root.render(
        <PluginIconSlot slot="sidebar.plugins" fallback={<span data-fallback="true" />} />
      )
    )
    expect(container.querySelector('[data-fallback="true"]')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('renders currentColor SVGs as masks that inherit host color', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const dataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
    const activeTheme = {
      id: 'plugin:acme.icons/main' as const,
      pluginKey: 'acme.icons',
      label: 'Acme',
      icons: {},
      fileNames: {},
      fileExtensions: { ts: { dataUrl, rendering: 'mask' as const } }
    }
    usePluginIconThemeStore.setState({
      activeId: activeTheme.id,
      activeTheme,
      loaded: true,
      themes: [activeTheme]
    })

    await act(async () =>
      root.render(<FileTypeIcon filePath="src/index.ts" style={{ color: 'rgb(255, 0, 0)' }} />)
    )

    const mask = container.querySelector<HTMLElement>('span[aria-hidden="true"]')
    expect(mask?.style.maskImage).toContain(dataUrl)
    expect(mask?.style.backgroundColor).toBe('currentcolor')
    expect(mask?.style.color).toBe('rgb(255, 0, 0)')
    expect(container.querySelector('img')).toBeNull()
    await act(async () => root.unmount())
  })
})
