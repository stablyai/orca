// @vitest-environment happy-dom

import { tmpdir } from 'node:os'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { clearAppAppearanceFromDocument } from '../lib/app-appearance-document'
import { APP_APPEARANCE_STYLE_PROPERTIES } from '../lib/left-sidebar-appearance'
import { useDocumentAppearance } from './use-document-appearance'

const mocks = vi.hoisted(() => ({
  settings: null as GlobalSettings | null,
  applyDocumentTheme: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: (selector: (state: { settings: GlobalSettings | null }) => unknown) =>
    selector({ settings: mocks.settings })
}))

vi.mock('../lib/document-theme', () => ({
  applyDocumentTheme: mocks.applyDocumentTheme
}))

vi.mock('../runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: mocks.scheduleRuntimeGraphSync
}))

function AppearanceProbe(): null {
  useDocumentAppearance()
  return null
}

describe('useDocumentAppearance', () => {
  let container: HTMLDivElement
  let root: Root
  let mediaListener: (() => void) | null
  let mediaMatches: boolean

  beforeEach(() => {
    mediaListener = null
    mediaMatches = true
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        get matches() {
          return mediaMatches
        },
        addEventListener: (_event: string, listener: () => void) => {
          mediaListener = listener
        },
        removeEventListener: vi.fn()
      }))
    })
    mocks.settings = {
      ...getDefaultSettings(tmpdir()),
      theme: 'system',
      leftSidebarAppearanceMode: 'match-terminal',
      terminalUseSeparateLightTheme: true
    }
    mocks.applyDocumentTheme.mockClear()
    mocks.scheduleRuntimeGraphSync.mockClear()
    container = document.createElement('div')
    document.documentElement.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    clearAppAppearanceFromDocument()
    document.documentElement.removeAttribute('data-app-appearance')
    document.documentElement.className = ''
    for (const property of APP_APPEARANCE_STYLE_PROPERTIES) {
      document.documentElement.style.removeProperty(property)
    }
  })

  it('preserves the bootstrap theme until settings hydrate', async () => {
    mocks.settings = null
    document.documentElement.classList.add('light')

    await act(async () => root.render(<AppearanceProbe />))

    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(mocks.applyDocumentTheme).not.toHaveBeenCalled()
  })

  it('reapplies terminal-derived document tokens on system theme changes', async () => {
    await act(async () => root.render(<AppearanceProbe />))
    const darkBackground = document.documentElement.style.getPropertyValue('--background')

    mediaMatches = false
    await act(async () => mediaListener?.())

    expect(document.documentElement.dataset.appAppearance).toBe('match-terminal')
    expect(document.documentElement.style.getPropertyValue('--background')).not.toBe(darkBackground)
    expect(mocks.applyDocumentTheme).toHaveBeenLastCalledWith(
      'system',
      expect.objectContaining({ disableTransitions: undefined })
    )
    expect(mocks.scheduleRuntimeGraphSync).toHaveBeenCalledOnce()
  })
})
