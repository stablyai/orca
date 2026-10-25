// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '../store'

const mocks = vi.hoisted(() => ({
  applyDocumentTheme: vi.fn(),
  buildAppFontFamily: vi.fn((fontFamily: string | null | undefined) => fontFamily ?? ''),
  media: {
    isDark: false,
    listeners: new Set<() => void>()
  }
}))

vi.mock('../lib/document-theme', () => ({
  applyDocumentTheme: mocks.applyDocumentTheme,
  resolveDocumentTheme: (theme: string) =>
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
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
    mocks.media.isDark = false
    mocks.media.listeners.clear()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return mocks.media.isDark
        },
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: (_type: string, listener: () => void) =>
          mocks.media.listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) =>
          mocks.media.listeners.delete(listener),
        dispatchEvent: vi.fn(() => true)
      }))
    )
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        theme: 'dark'
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    vi.unstubAllGlobals()
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

  it('re-applies the workspace split divider without interrupting document transitions', () => {
    const { unmount } = renderHook(() => useDocumentAppearance())

    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: { ...settings, tabGroupSplitDividerColorDark: '#ff0000' }
      })
    })

    expect(document.documentElement.style.getPropertyValue('--tab-group-split-divider')).toBe(
      '#ff0000'
    )
    expect(mocks.applyDocumentTheme).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('uses the latest divider colors after a system theme change', () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        theme: 'system',
        tabGroupSplitDividerColorDark: '#111111',
        tabGroupSplitDividerColorLight: '#eeeeee'
      }
    })
    const { unmount } = renderHook(() => useDocumentAppearance())

    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings!,
          tabGroupSplitDividerColorDark: '#222222'
        }
      })
    })
    expect(mocks.applyDocumentTheme).toHaveBeenCalledTimes(1)
    expect(document.documentElement.style.getPropertyValue('--tab-group-split-divider')).toBe(
      '#eeeeee'
    )

    act(() => {
      mocks.media.isDark = true
      for (const listener of mocks.media.listeners) {
        listener()
      }
    })

    expect(mocks.applyDocumentTheme).toHaveBeenCalledTimes(2)
    expect(mocks.applyDocumentTheme).toHaveBeenLastCalledWith('system')
    expect(document.documentElement.style.getPropertyValue('--tab-group-split-divider')).toBe(
      '#222222'
    )
    unmount()
  })
})
