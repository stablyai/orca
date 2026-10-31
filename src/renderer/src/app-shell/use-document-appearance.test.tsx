// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '../store'
import { usePluginThemeStore } from '../store/plugin-themes'
import { resetSystemPrefersDarkSubscriptionForTests } from '@/components/terminal-pane/use-system-prefers-dark'

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

  const pluginTheme = (name: string, base: 'light' | 'dark') => ({
    id: `plugin:samples.${name}/${name}` as const,
    revision: 'r1',
    pluginKey: `samples.${name}`,
    pluginName: name,
    label: name,
    base,
    tokens: { '--background': base === 'dark' ? '#1a1025' : '#fafafa' }
  })
  const midnight = pluginTheme('midnight', 'light')
  const dusk = pluginTheme('dusk', 'dark')

  function storeUpdates(): void {
    useAppStore.setState({
      updateSettings: async (updates) => {
        const current = useAppStore.getState().settings ?? getDefaultSettings('/tmp')
        useAppStore.setState({ settings: { ...current, ...updates } })
      }
    })
  }

  it('moves a legacy single theme into the slot of its base without changing the mode', async () => {
    usePluginThemeStore.setState({ entries: [midnight], loaded: true })
    storeUpdates()
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: {
          ...settings,
          theme: 'light',
          themeBeforePlugin: 'dark',
          pluginAppTheme: midnight.id
        }
      })
    })
    const { unmount } = renderHook(() => useDocumentAppearance())
    await vi.waitFor(() =>
      expect(useAppStore.getState().settings).toMatchObject({
        theme: 'light',
        pluginAppTheme: null,
        themeBeforePlugin: null,
        pluginAppThemeLight: midnight.id,
        pluginAppThemeDark: null
      })
    )
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(midnight)
    unmount()
    usePluginThemeStore.setState({ entries: [], loaded: false })
  })

  it('swaps between the light and dark slots live when the OS appearance flips', () => {
    const listeners = new Set<(event: { matches: boolean }) => void>()
    let systemDark = false
    const media = {
      get matches() {
        return systemDark
      },
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
        listeners.delete(listener)
    }
    vi.stubGlobal('matchMedia', () => media)
    resetSystemPrefersDarkSubscriptionForTests()
    usePluginThemeStore.setState({ entries: [midnight, dusk], loaded: true })
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: {
          ...settings,
          theme: 'system',
          pluginAppThemeLight: midnight.id,
          pluginAppThemeDark: dusk.id
        }
      })
    })
    const { unmount } = renderHook(() => useDocumentAppearance())
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(midnight)
    act(() => {
      systemDark = true
      for (const listener of listeners) {
        listener({ matches: true })
      }
    })
    expect(mocks.applyDocumentTheme).toHaveBeenLastCalledWith('system')
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(dusk)
    unmount()
    vi.unstubAllGlobals()
    resetSystemPrefersDarkSubscriptionForTests()
    usePluginThemeStore.setState({ entries: [], loaded: false })
  })

  it("paints the built-in colors while a slot's plugin is disabled and keeps the slot", () => {
    usePluginThemeStore.setState({ entries: [dusk], loaded: true })
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ updateSettings })
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: { ...settings, theme: 'dark', pluginAppThemeDark: dusk.id }
      })
    })
    const { unmount } = renderHook(() => useDocumentAppearance())
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(dusk)
    // A disabled plugin's themes leave the list; re-enabling paints the same slot again.
    act(() => usePluginThemeStore.setState({ entries: [] }))
    expect(mocks.applyPluginAppTheme).toHaveBeenLastCalledWith(null)
    expect(updateSettings).not.toHaveBeenCalled()
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
