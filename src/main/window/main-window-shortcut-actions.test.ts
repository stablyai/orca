import { describe, expect, it, vi } from 'vitest'

const { openRuntimeClientWindowFromUserCommandMock } = vi.hoisted(() => ({
  openRuntimeClientWindowFromUserCommandMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { send: vi.fn(), id: 1, reloadIgnoringCache: vi.fn() }
  }
}))
vi.mock('./runtime-client-window-open-command', () => ({
  openRuntimeClientWindowFromUserCommand: openRuntimeClientWindowFromUserCommandMock
}))

import { BrowserWindow } from 'electron'
import { sendResolvedWindowShortcutAction } from './main-window-shortcut-actions'

describe('sendResolvedWindowShortcutAction', () => {
  it('opens exactly one window for a single newWindow action and sends no renderer IPC', () => {
    const mainWindow = new BrowserWindow()

    sendResolvedWindowShortcutAction(mainWindow, { type: 'newWindow' })

    expect(openRuntimeClientWindowFromUserCommandMock).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})
