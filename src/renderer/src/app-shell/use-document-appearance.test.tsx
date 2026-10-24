// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '../store'
import { usePluginThemeStore } from '../store/plugin-themes'

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

  it('applies a selected plugin theme and restores the earlier choice when it disappears', async () => {
    const midnight = {
      id: 'plugin:samples.midnight/midnight' as const,
      revision: 'r1',
      pluginKey: 'samples.midnight',
      pluginName: 'Midnight',
      label: 'Midnight',
      base: 'light' as const,
      tokens: { '--background': '#fafafa' }
    }
    usePluginThemeStore.setState({ entries: [midnight], loaded: true })
    useAppStore.setState({
      updateSettings: async (updates) => {
        const current = useAppStore.getState().settings ?? getDefaultSettings('/tmp')
        useAppStore.setState({ settings: { ...current, ...updates } })
      }
    })
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: {
          ...settings,
          theme: midnight.base,
          themeBeforePlugin: 'dark',
          pluginAppTheme: midnight.id
        }
      })
    })
    const { unmount } = renderHook(() => useDocumentAppearance())
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(midnight)
    expect(mocks.applyDocumentTheme).toHaveBeenLastCalledWith('light')

    act(() => usePluginThemeStore.setState({ entries: [] }))
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(null)
    // The earlier built-in choice comes back with the built-in colors.
    await vi.waitFor(() => expect(useAppStore.getState().settings?.theme).toBe('dark'))
    unmount()
    usePluginThemeStore.setState({ entries: [], loaded: false })
  })

  it("falls back to the earlier choice while the selected theme's plugin is disabled", async () => {
    const dusk = {
      id: 'plugin:samples.dusk/dusk' as const,
      revision: 'r1',
      pluginKey: 'samples.dusk',
      pluginName: 'Dusk',
      label: 'Dusk',
      base: 'dark' as const,
      tokens: { '--background': '#1a1025' }
    }
    usePluginThemeStore.setState({ entries: [dusk], loaded: true })
    useAppStore.setState({
      updateSettings: async (updates) => {
        const current = useAppStore.getState().settings ?? getDefaultSettings('/tmp')
        useAppStore.setState({ settings: { ...current, ...updates } })
      }
    })
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: {
          ...settings,
          theme: 'dark',
          themeBeforePlugin: 'light',
          pluginAppTheme: dusk.id
        }
      })
    })
    const { unmount } = renderHook(() => useDocumentAppearance())
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(dusk)
    // A disabled plugin's themes leave the list, and its saved choice is no longer backed.
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({ settings: { ...settings, disabledPlugins: [dusk.pluginKey] } })
      usePluginThemeStore.setState({ entries: [] })
    })
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(null)
    await vi.waitFor(() => expect(useAppStore.getState().settings?.theme).toBe('light'))
    unmount()
    usePluginThemeStore.setState({ entries: [], loaded: false })
  })

  it('selects no theme when one appears without a click (update, startup discovery, refresh)', () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ updateSettings })
    usePluginThemeStore.setState({ entries: [], loaded: true })
    const { unmount } = renderHook(() => useDocumentAppearance())
    mocks.applyDocumentTheme.mockClear()
    mocks.applyPluginAppTheme.mockClear()

    // Why: only a user's install/enable click, Use now or Appearance picks a plugin theme.
    act(() =>
      usePluginThemeStore.setState({
        entries: [
          {
            id: 'plugin:samples.dusk/dusk',
            revision: 'r1',
            pluginKey: 'samples.dusk',
            pluginName: 'Dusk',
            label: 'Dusk',
            base: 'dark',
            tokens: { '--background': '#1a1025' }
          }
        ]
      })
    )

    expect(updateSettings).not.toHaveBeenCalled()
    expect(mocks.applyDocumentTheme).not.toHaveBeenCalled()
    expect(mocks.applyPluginAppTheme).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'plugin:samples.dusk/dusk' })
    )
    unmount()
    usePluginThemeStore.setState({ entries: [], loaded: false })
  })
})
