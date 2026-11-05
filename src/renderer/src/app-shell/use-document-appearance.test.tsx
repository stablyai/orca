// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '../store'

const mocks = vi.hoisted(() => ({
  applyDocumentTheme: vi.fn(),
  applyPluginAppTheme: vi.fn(),
  buildAppFontFamily: vi.fn((fontFamily: string | null | undefined) => fontFamily ?? '')
}))

vi.mock('../lib/document-theme', () => ({
  applyDocumentTheme: mocks.applyDocumentTheme,
  applyPluginAppTheme: mocks.applyPluginAppTheme,
  readCachedPluginAppTheme: () => null
}))

vi.mock('@/lib/app-font-family', () => ({
  buildAppFontFamily: mocks.buildAppFontFamily
}))

vi.mock('../runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))

import { useDocumentAppearance } from './use-document-appearance'

const initialState = useAppStore.getState()

describe('useDocumentAppearance', () => {
  beforeEach(() => {
    mocks.applyDocumentTheme.mockReset()
    mocks.buildAppFontFamily.mockClear()
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        theme: 'dark'
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    // The document root is shared between cases, so a write here would leak forward.
    document.documentElement.style.removeProperty('--pane-single-max-width')
    document.documentElement.style.removeProperty('--pane-single-edge-width')
  })

  it('publishes the single-pane cap on the document root and clears it when unset', () => {
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({ settings: { ...settings, terminalSinglePaneMaxWidth: 900 } })
    })
    const { unmount } = renderHook(() => useDocumentAppearance())

    expect(document.documentElement.style.getPropertyValue('--pane-single-max-width')).toBe('900px')

    act(() => {
      const { terminalSinglePaneMaxWidth: _dropped, ...rest } = useAppStore.getState().settings!
      useAppStore.setState({ settings: rest })
    })

    expect(document.documentElement.style.getPropertyValue('--pane-single-max-width')).toBe('')
    unmount()
  })
})
