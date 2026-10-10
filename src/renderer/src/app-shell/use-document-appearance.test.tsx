// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '../store'

const mocks = vi.hoisted(() => ({
  applyDocumentTheme: vi.fn(),
  buildAppFontFamily: vi.fn((fontFamily: string | null | undefined) => fontFamily ?? '')
}))

vi.mock('../lib/document-theme', () => ({
  applyDocumentTheme: mocks.applyDocumentTheme
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

  it('ignores unrelated settings object replacements', () => {
    const { unmount } = renderHook(() => useDocumentAppearance())

    expect(mocks.applyDocumentTheme).toHaveBeenCalledTimes(1)
    expect(mocks.buildAppFontFamily).toHaveBeenCalledTimes(1)

    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: { ...settings, editorAutoSave: !settings.editorAutoSave }
      })
    })

    expect(mocks.applyDocumentTheme).toHaveBeenCalledTimes(1)
    expect(mocks.buildAppFontFamily).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('still applies changed theme and font values', () => {
    const { unmount } = renderHook(() => useDocumentAppearance())

    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: { ...settings, theme: 'light', appFontFamily: 'Monaco' }
      })
    })

    expect(mocks.applyDocumentTheme).toHaveBeenLastCalledWith('light')
    expect(mocks.applyDocumentTheme).toHaveBeenCalledTimes(2)
    expect(mocks.buildAppFontFamily).toHaveBeenLastCalledWith('Monaco')
    expect(mocks.buildAppFontFamily).toHaveBeenCalledTimes(2)
    unmount()
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
