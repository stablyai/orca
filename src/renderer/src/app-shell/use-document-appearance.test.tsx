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

  it('applies interface glass only on a glass window', () => {
    const root = document.documentElement
    const setWindowGlass = (windowGlass: boolean): void => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { platform: { get: () => ({ windowGlass }) } }
      })
    }
    const enableInterfaceGlass = (): void => {
      act(() => {
        const settings = useAppStore.getState().settings!
        useAppStore.setState({
          settings: { ...settings, interfaceGlass: true, interfaceGlassOpacity: 0.5 }
        })
      })
    }

    setWindowGlass(false)
    const first = renderHook(() => useDocumentAppearance())
    enableInterfaceGlass()
    expect(root.classList.contains('interface-glass')).toBe(false)
    first.unmount()

    setWindowGlass(true)
    const second = renderHook(() => useDocumentAppearance())
    expect(root.classList.contains('window-glass')).toBe(true)
    expect(root.classList.contains('interface-glass')).toBe(true)
    expect(root.style.getPropertyValue('--interface-glass-opacity')).toBe('0.5')
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({ settings: { ...settings, interfaceGlass: false } })
    })
    expect(root.classList.contains('interface-glass')).toBe(false)
    second.unmount()
    root.classList.remove('window-glass')
    Reflect.deleteProperty(window, 'api')
  })

  it('gives terminals the chat glass tint only on a glass window', () => {
    const root = document.documentElement
    const setWindowGlass = (windowGlass: boolean): void => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { platform: { get: () => ({ windowGlass }) } }
      })
    }
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({ settings: { ...settings, terminalChatGlass: true } })
    })

    setWindowGlass(false)
    const first = renderHook(() => useDocumentAppearance())
    expect(root.classList.contains('terminal-chat-glass')).toBe(false)
    first.unmount()

    setWindowGlass(true)
    const second = renderHook(() => useDocumentAppearance())
    expect(root.classList.contains('terminal-chat-glass')).toBe(true)
    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({ settings: { ...settings, terminalChatGlass: false } })
    })
    expect(root.classList.contains('terminal-chat-glass')).toBe(false)
    second.unmount()
    root.classList.remove('window-glass')
    Reflect.deleteProperty(window, 'api')
  })
})
