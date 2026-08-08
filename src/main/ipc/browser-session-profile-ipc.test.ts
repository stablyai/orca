import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, createProfileMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  createProfileMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
  webContents: { fromId: vi.fn() }
}))

vi.mock('../browser/browser-manager', () => ({
  browserCertificateTrustController: { proceed: vi.fn() },
  browserManager: {
    getWebContentsIdByTabId: vi.fn(() => new Map())
  }
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    createProfile: createProfileMock
  }
}))

vi.mock('../browser/browser-cookie-import', () => ({
  detectInstalledBrowsers: vi.fn(() => []),
  importCookiesFromBrowser: vi.fn(),
  importCookiesFromFile: vi.fn(),
  pickCookieFile: vi.fn(),
  selectBrowserProfile: vi.fn()
}))

import { registerBrowserHandlers, setTrustedBrowserRendererWebContentsId } from './browser'

describe('browser session profile IPC', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    createProfileMock.mockReset()
    setTrustedBrowserRendererWebContentsId(null)
  })

  it('forwards the user-agent mode from a trusted renderer', () => {
    const profile = {
      id: 'profile-google',
      scope: 'isolated',
      partition: 'persist:orca-browser-session-profile-google',
      label: 'Google',
      source: null,
      userAgentMode: 'native'
    }
    createProfileMock.mockReturnValue(profile)
    registerBrowserHandlers()
    const createHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:session:createProfile'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: { scope: 'isolated'; label: string; userAgentMode: 'native' }
    ) => unknown
    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    expect(
      createHandler({ sender }, { scope: 'isolated', label: 'Google', userAgentMode: 'native' })
    ).toEqual(profile)
    expect(createProfileMock).toHaveBeenCalledWith('isolated', 'Google', {
      userAgentMode: 'native'
    })
  })
})
