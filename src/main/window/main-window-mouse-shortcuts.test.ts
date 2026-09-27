import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    ...harness.electronModuleMock(),
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() })
  }
})
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

import { ipcMain } from 'electron'
import { createMainWindow } from './createMainWindow'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

const mouseInput = {
  key: 'MouseBack',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false
}

function setup() {
  const events = new EventEmitter()
  const webContents = {
    mainFrame: {},
    on: vi.fn(),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn()
  }
  const instance = {
    webContents,
    on: events.on.bind(events),
    isDestroyed: () => false,
    isMaximized: () => true,
    isFullScreen: () => false,
    getSize: () => [1200, 800],
    setSize: vi.fn(),
    maximize: vi.fn(),
    loadFile: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {})
  }
  browserWindowMock.mockImplementation(function () {
    return instance
  })
  createMainWindow(null, { getKeybindings: () => ({ 'app.settings': ['MouseBack'] }) })
  const event = { sender: webContents, senderFrame: webContents.mainFrame, preventDefault: vi.fn() }
  return { event, webContents, events }
}

describe('native mouse shortcut routing', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    ipcMain.removeAllListeners()
  })

  it('runs an assigned native action and removes its listener when the window closes', () => {
    const { event, webContents, events } = setup()
    ipcMain.emit('ui:dispatchMouseShortcut', event, mouseInput)
    expect(webContents.send).toHaveBeenCalledExactlyOnceWith('ui:openSettings')
    events.emit('closed')
    expect(ipcMain.listenerCount('ui:dispatchMouseShortcut')).toBe(0)
  })

  it('rejects other senders, subframes, non-mouse inputs and unmatched modifiers', () => {
    const { event, webContents } = setup()
    ipcMain.emit('ui:dispatchMouseShortcut', { ...event, sender: {} }, mouseInput)
    ipcMain.emit('ui:dispatchMouseShortcut', { ...event, senderFrame: {} }, mouseInput)
    ipcMain.emit('ui:dispatchMouseShortcut', event, { ...mouseInput, key: 'R' })
    ipcMain.emit('ui:dispatchMouseShortcut', event, { ...mouseInput, shiftKey: true })
    expect(webContents.send).not.toHaveBeenCalled()
  })

  it('never executes while the shortcut recorder is active', () => {
    const { event, webContents } = setup()
    ipcMain.emit('ui:setShortcutRecorderFocused', event, true)
    ipcMain.emit('ui:dispatchMouseShortcut', event, mouseInput)
    expect(webContents.send).not.toHaveBeenCalled()
  })
})
