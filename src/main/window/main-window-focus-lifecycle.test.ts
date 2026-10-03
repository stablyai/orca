import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)

import { ipcMain } from 'electron'
import { installMainWindowFocusLifecycle } from './main-window-focus-lifecycle'
import { resetMainWindowMocks } from './createMainWindow-test-harness'

describe('installMainWindowFocusLifecycle', () => {
  let destroyed = false
  const mockWebContents = {
    id: 42,
    mainFrame: {},
    isDestroyed: vi.fn(() => destroyed),
    on: vi.fn(),
    send: vi.fn()
  }

  const mockMainWindow = {
    isDestroyed: vi.fn(() => destroyed),
    get webContents() {
      if (destroyed) {
        throw new TypeError('Object has been destroyed')
      }
      return mockWebContents
    }
  }

  beforeEach(() => {
    resetMainWindowMocks()
    destroyed = false
    vi.clearAllMocks()
  })

  it('updates focus states when window is alive and sender is valid', () => {
    const lifecycle = installMainWindowFocusLifecycle({
      isWindowClosing: () => false,
      mainWindow: mockMainWindow as never,
      reloadMainWindow: vi.fn(),
      rendererWebContentsId: 42
    })

    const getListener = (ch: string) =>
      vi.mocked(ipcMain.on).mock.calls.find(([channel]) => channel === ch)?.[1]

    expect(lifecycle.isTerminalInputFocused()).toBe(false)
    getListener('ui:setTerminalInputFocused')?.({ sender: mockWebContents } as never, true)
    expect(lifecycle.isTerminalInputFocused()).toBe(true)

    expect(lifecycle.isMarkdownEditorFocused()).toBe(false)
    getListener('ui:setMarkdownEditorFocused')?.({ sender: mockWebContents } as never, true)
    expect(lifecycle.isMarkdownEditorFocused()).toBe(true)

    expect(lifecycle.isFloatingPanelFocused()).toBe(false)
    getListener('ui:setFloatingFocus')?.({ sender: mockWebContents } as never, {
      terminalFocused: true,
      panelFocused: true
    })
    expect(lifecycle.isFloatingPanelFocused()).toBe(true)

    expect(lifecycle.isShortcutRecorderFocused()).toBe(false)
    getListener('ui:setShortcutRecorderFocused')?.({ sender: mockWebContents } as never, true)
    expect(lifecycle.isShortcutRecorderFocused()).toBe(true)

    lifecycle.dispose()
  })

  it('does not crash or throw "Object has been destroyed" when mainWindow is destroyed', () => {
    const lifecycle = installMainWindowFocusLifecycle({
      isWindowClosing: () => false,
      mainWindow: mockMainWindow as never,
      reloadMainWindow: vi.fn(),
      rendererWebContentsId: 42
    })

    const terminalListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    const markdownListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setMarkdownEditorFocused')?.[1]
    const floatingListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setFloatingFocus')?.[1]
    const recorderListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setShortcutRecorderFocused')?.[1]

    // Simulate window destroyed
    destroyed = true

    expect(() => {
      terminalListener?.({ sender: mockWebContents } as never, true)
      markdownListener?.({ sender: mockWebContents } as never, true)
      floatingListener?.({ sender: mockWebContents } as never, { terminalFocused: true })
      recorderListener?.({ sender: mockWebContents } as never, true)
    }).not.toThrow()

    lifecycle.dispose()
  })

  it('removes ipcMain listeners upon dispose', () => {
    const lifecycle = installMainWindowFocusLifecycle({
      isWindowClosing: () => false,
      mainWindow: mockMainWindow as never,
      reloadMainWindow: vi.fn(),
      rendererWebContentsId: 42
    })

    lifecycle.dispose()

    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      'ui:setTerminalInputFocused',
      expect.any(Function)
    )
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      'ui:setMarkdownEditorFocused',
      expect.any(Function)
    )
    expect(ipcMain.removeListener).toHaveBeenCalledWith('ui:setFloatingFocus', expect.any(Function))
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      'ui:setShortcutRecorderFocused',
      expect.any(Function)
    )
    expect(ipcMain.removeListener).toHaveBeenCalledWith(
      'rich-markdown:context-target',
      expect.any(Function)
    )
  })
})
