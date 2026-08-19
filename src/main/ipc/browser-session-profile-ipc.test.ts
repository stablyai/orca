import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  removeHandlerMock,
  createProfileMock,
  getProfileMock,
  updateProfileSourceMock,
  detectAllBrowsersMock,
  importCookiesFromBrowserMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  createProfileMock: vi.fn(),
  getProfileMock: vi.fn(),
  updateProfileSourceMock: vi.fn(),
  detectAllBrowsersMock: vi.fn(),
  importCookiesFromBrowserMock: vi.fn()
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
    createProfile: createProfileMock,
    getProfile: getProfileMock,
    updateProfileSource: updateProfileSourceMock
  }
}))

vi.mock('../browser/browser-cookie-import', () => ({
  detectAllBrowsers: detectAllBrowsersMock,
  importCookiesFromBrowser: importCookiesFromBrowserMock,
  importCookiesFromFile: vi.fn(),
  pickCookieFile: vi.fn(),
  selectBrowserProfile: vi.fn()
}))

import { registerBrowserHandlers } from './browser'
import { setTrustedBrowserRendererWebContentsId } from './browser-renderer-trust'

describe('browser session profile IPC', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    createProfileMock.mockReset()
    getProfileMock.mockReset()
    updateProfileSourceMock.mockReset()
    detectAllBrowsersMock.mockReset()
    importCookiesFromBrowserMock.mockReset()
    setTrustedBrowserRendererWebContentsId(null)
  })

  const trustedSender = {
    id: 91,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///renderer/index.html'
  } as Electron.WebContents

  function getHandler(channel: string): (...args: unknown[]) => unknown {
    registerBrowserHandlers()
    setTrustedBrowserRendererWebContentsId(trustedSender.id)
    return handleMock.mock.calls.find(([registered]) => registered === channel)?.[1] as (
      ...args: unknown[]
    ) => unknown
  }

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

  it('exposes customBrowserId but strips filesystem paths and keychain identifiers', async () => {
    detectAllBrowsersMock.mockResolvedValue([
      {
        family: 'custom',
        label: 'Vivaldi',
        cookiesPath: '/Users/x/Library/Application Support/Vivaldi/Default/Cookies',
        keychainService: 'Vivaldi Safe Storage',
        keychainAccount: 'Vivaldi',
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default',
        customBrowserId: 'com.vivaldi.Vivaldi'
      }
    ])
    const detectHandler = getHandler('browser:session:detectBrowsers')

    const detected = (await detectHandler({ sender: trustedSender })) as Record<string, unknown>[]

    expect(detected).toEqual([
      {
        family: 'custom',
        label: 'Vivaldi',
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default',
        customBrowserId: 'com.vivaldi.Vivaldi'
      }
    ])
    // Why: the security strip must never leak these to the renderer.
    expect(detected[0]).not.toHaveProperty('cookiesPath')
    expect(detected[0]).not.toHaveProperty('keychainService')
    expect(detected[0]).not.toHaveProperty('keychainAccount')
  })

  it('matches a custom browser by customBrowserId on import, not by family', async () => {
    getProfileMock.mockReturnValue({ id: 'default', partition: 'persist:default' })
    importCookiesFromBrowserMock.mockResolvedValue({
      ok: true,
      summary: { totalCookies: 1, importedCookies: 1, skippedCookies: 0, domains: [] }
    })
    const vivaldi = {
      family: 'custom',
      label: 'Vivaldi',
      cookiesPath: '/vivaldi/Cookies',
      profiles: [{ name: 'Default', directory: 'Default' }],
      selectedProfile: 'Default',
      customBrowserId: 'com.vivaldi.Vivaldi'
    }
    const opera = {
      family: 'custom',
      label: 'Opera',
      cookiesPath: '/opera/Cookies',
      profiles: [{ name: 'Default', directory: 'Default' }],
      selectedProfile: 'Default',
      customBrowserId: 'com.operasoftware.Opera'
    }
    // Two 'custom'-family browsers: only customBrowserId disambiguates them.
    detectAllBrowsersMock.mockResolvedValue([vivaldi, opera])
    const importHandler = getHandler('browser:session:importFromBrowser')

    const result = await importHandler(
      { sender: trustedSender },
      { profileId: 'default', browserFamily: 'custom', customBrowserId: 'com.operasoftware.Opera' }
    )

    expect(result).toMatchObject({ ok: true, profileId: 'default' })
    expect(importCookiesFromBrowserMock).toHaveBeenCalledWith(opera, 'persist:default')
    expect(updateProfileSourceMock).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ browserFamily: 'custom', profileName: 'Default' })
    )
  })
})
