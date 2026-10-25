// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { _resetTerminalViewAttributesPublisherForTest } from '../components/terminal-pane/terminal-view-attributes-publisher'
import { useAppStore } from '../store'

const mocks = vi.hoisted(() => ({
  setColors: vi.fn(),
  pushToAllHosts: vi.fn(),
  publishTerminalViewAttributes: vi.fn()
}))

vi.mock('../runtime/remote-runtime-terminal-color-push', () => ({
  remoteRuntimeTerminalColorPush: {
    setColors: mocks.setColors,
    pushToAllHosts: mocks.pushToAllHosts
  }
}))

import { useTerminalViewerColorPublication } from './use-terminal-viewer-color-publication'

const initialState = useAppStore.getState()

describe('useTerminalViewerColorPublication', () => {
  beforeEach(() => {
    _resetTerminalViewAttributesPublisherForTest()
    Object.assign(window, {
      api: { pty: { publishTerminalViewAttributes: mocks.publishTerminalViewAttributes } }
    })
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), theme: 'dark' } })
  })

  afterEach(() => {
    vi.clearAllMocks()
    useAppStore.setState(initialState, true)
    _resetTerminalViewAttributesPublisherForTest()
  })

  it('publishes a theme change with no terminal pane open, to main and to paired hosts', () => {
    const { unmount } = renderHook(() => useTerminalViewerColorPublication())
    expect(mocks.setColors).toHaveBeenLastCalledWith({
      foreground: '#ffffff',
      background: '#282c34'
    })

    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({ settings: { ...settings, theme: 'light' } })
    })

    expect(mocks.publishTerminalViewAttributes).toHaveBeenCalledTimes(2)
    expect(mocks.setColors).toHaveBeenLastCalledWith({
      foreground: '#2e3434',
      background: '#ffffff'
    })
    unmount()
  })

  it('does not republish for an unrelated settings edit', () => {
    const { unmount } = renderHook(() => useTerminalViewerColorPublication())

    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({ settings: { ...settings, editorAutoSave: !settings.editorAutoSave } })
    })

    expect(mocks.publishTerminalViewAttributes).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('re-pushes the window colours to paired hosts when it gains focus', () => {
    const { unmount } = renderHook(() => useTerminalViewerColorPublication())

    window.dispatchEvent(new Event('focus'))
    unmount()
    window.dispatchEvent(new Event('focus'))

    expect(mocks.pushToAllHosts).toHaveBeenCalledTimes(1)
  })
})
