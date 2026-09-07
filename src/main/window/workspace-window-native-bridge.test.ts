import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>(),
  showOpenDialog: vi.fn(),
  openExternal: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn((sender: { owner?: unknown }) => sender.owner ?? null)
  },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  shell: { openExternal: mocks.openExternal },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown) => unknown) => {
      mocks.handlers.set(channel, handler)
    })
  }
}))

import {
  authorizeWorkspaceWindowNativeBridge,
  registerWorkspaceWindowNativeBridge
} from './workspace-window-native-bridge'

describe('workspace window native bridge', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.showOpenDialog.mockReset()
    registerWorkspaceWindowNativeBridge()
  })

  it('opens project folder dialogs only for an authorized workspace window origin', async () => {
    const mainFrame = { url: 'http://127.0.0.1:6768/web-index.html' }
    const webContents = {
      id: 41,
      owner: undefined as unknown,
      mainFrame,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    const owner = {
      close: vi.fn(),
      destroy: vi.fn(),
      id: 1,
      isDestroyed: vi.fn(() => true),
      once: vi.fn(),
      webContents
    }
    webContents.owner = owner
    authorizeWorkspaceWindowNativeBridge(
      owner as never,
      'http://127.0.0.1:6768/web-index.html?pairing=secret'
    )
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:/repo'] })

    const handler = mocks.handlers.get('workspaceWindow:pickFolder')!
    await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toBe('C:/repo')
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(owner, {
      properties: ['openDirectory']
    })

    await expect(
      handler({ sender: webContents, senderFrame: { url: 'https://attacker.example/' } })
    ).rejects.toThrow('workspace_window_native_bridge_unauthorized')

    mocks.handlers.get('workspaceWindow:requestClose')!({
      sender: webContents,
      senderFrame: mainFrame
    })
    mocks.handlers.get('workspaceWindow:confirmClose')!({
      sender: webContents,
      senderFrame: mainFrame
    })
    expect(
      mocks.handlers.get('workspaceWindow:getWindowId')!({
        sender: webContents,
        senderFrame: mainFrame
      })
    ).toBe(1)
    expect(owner.close).toHaveBeenCalledOnce()
    expect(owner.destroy).toHaveBeenCalledOnce()
  })

  it('rejects same-origin subframes and prevents navigation or popups outside the authorized origin', async () => {
    const listeners = new Map<string, (...args: any[]) => void>()
    const mainFrame = { url: 'http://127.0.0.1:6768/web-index.html' }
    const webContents = {
      id: 42,
      owner: undefined as unknown,
      mainFrame,
      on: vi.fn((name, listener) => listeners.set(name, listener)),
      setWindowOpenHandler: vi.fn()
    }
    const owner = { webContents, once: vi.fn() }
    webContents.owner = owner
    authorizeWorkspaceWindowNativeBridge(owner as never, mainFrame.url)
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(
      mocks.handlers.get('workspaceWindow:pickFolder')!({
        sender: webContents,
        senderFrame: { url: mainFrame.url }
      })
    ).rejects.toThrow('workspace_window_native_bridge_unauthorized')
    for (const event of ['will-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      listeners.get(event)?.({ preventDefault }, 'https://attacker.example/')
      expect(preventDefault).toHaveBeenCalledOnce()
      preventDefault.mockClear()
      listeners.get(event)?.({ preventDefault }, mainFrame.url)
      expect(preventDefault).not.toHaveBeenCalled()
    }
    expect(
      webContents.setWindowOpenHandler.mock.calls[0]?.[0]({ url: 'https://attacker.example/' })
    ).toEqual({ action: 'deny' })
    expect(mocks.openExternal).toHaveBeenCalledWith('https://attacker.example/')
    mocks.openExternal.mockClear()
    webContents.setWindowOpenHandler.mock.calls[0]?.[0]({ url: 'file:///C:/private.txt' })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
