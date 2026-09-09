import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  browserWindowMock,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'

function mountWindow(): {
  beforeInput: (event: { preventDefault: () => void }, input: Record<string, unknown>) => void
  setTerminalFocused: (focused: boolean) => void
  webContents: { send: ReturnType<typeof vi.fn> }
} {
  const windowHandlers: Record<string, (...args: never[]) => void> = {}
  const webContents = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      windowHandlers[event] = handler
    }),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isDevToolsOpened: vi.fn(),
    openDevTools: vi.fn(),
    closeDevTools: vi.fn()
  }
  browserWindowMock.mockImplementation(function () {
    return {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
    }
  })
  createMainWindow({
    getUI: () => ({}),
    getSettings: () => ({})
  } as never)
  const setFocusedListener = vi
    .mocked(ipcMain.on)
    .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
  return {
    beforeInput: windowHandlers['before-input-event'] as never,
    setTerminalFocused: (focused) => {
      setFocusedListener?.({ sender: webContents } as never, focused)
    },
    webContents
  }
}

const bareAlt = {
  type: 'keyDown',
  key: 'Alt',
  code: 'AltLeft',
  alt: true,
  control: false,
  meta: false,
  shift: false
}

describe('terminal Alt menu-bar toggle', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
  })

  it('prevents Windows Alt from revealing the menu while the terminal is focused', () => {
    withPlatform('win32', () => {
      const { beforeInput, setTerminalFocused, webContents } = mountWindow()
      setTerminalFocused(true)
      const preventDefault = vi.fn()
      beforeInput({ preventDefault }, bareAlt)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(webContents.send).not.toHaveBeenCalled()
    })
  })

  it('lets Alt+Q reach the renderer so Pi can dequeue', () => {
    withPlatform('win32', () => {
      const { beforeInput, setTerminalFocused, webContents } = mountWindow()
      setTerminalFocused(true)
      const preventDefault = vi.fn()
      beforeInput({ preventDefault }, { ...bareAlt, key: 'q', code: 'KeyQ' })
      expect(preventDefault).not.toHaveBeenCalled()
      expect(webContents.send).not.toHaveBeenCalled()
    })
  })

  it('still reveals the menu on Alt when the terminal is not focused', () => {
    withPlatform('win32', () => {
      const { beforeInput, webContents } = mountWindow()
      const preventDefault = vi.fn()
      beforeInput({ preventDefault }, bareAlt)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(webContents.send).not.toHaveBeenCalled()
    })
  })
})
