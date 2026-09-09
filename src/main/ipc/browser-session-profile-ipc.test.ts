import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  removeHandlerMock,
  createProfileMock,
  routeIdentityMock,
  getProfileMock,
  updateProfileSourceMock,
  detectAllBrowsersMock,
  importCookiesFromBrowserMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  createProfileMock: vi.fn(),
  routeIdentityMock: vi.fn(),
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

vi.mock('../browser/paired-runtime-browser-client-host-runtime', () => ({
  getPairedRuntimeBrowserClientRouteIdentity: routeIdentityMock
}))

vi.mock('../browser/browser-cookie-import', () => ({
  detectAllBrowsers: detectAllBrowsersMock,
  detectInstalledBrowsers: vi.fn(() => []),
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
    routeIdentityMock.mockReset()
    getProfileMock.mockReset()
    updateProfileSourceMock.mockReset()
    detectAllBrowsersMock.mockReset()
    detectAllBrowsersMock.mockResolvedValue([])
    importCookiesFromBrowserMock.mockReset()
    setTrustedBrowserRendererWebContentsId(null)
  })

  function trustedSender(): Electron.WebContents {
    return {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents
  }

  function getHandler(channel: string): (...args: unknown[]) => unknown {
    registerBrowserHandlers()
    setTrustedBrowserRendererWebContentsId(trustedSender().id)
    return handleMock.mock.calls.find(([registered]) => registered === channel)?.[1] as (
      ...args: unknown[]
    ) => unknown
  }

  function clientHostDetectHandler(): (
    event: { sender: Electron.WebContents },
    args: { environmentId: string }
  ) => unknown {
    registerBrowserHandlers()
    return handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:session:detectBrowsersForClientHost'
    )?.[1]
  }

  // Why: the import runs wherever the pages are hosted, so the picker must be sourced from the same
  // machine — a remote-sourced list is either empty (headless) or names profiles this desktop lacks.
  it('detects this desktop’s browsers only while the environment is client-hosted', async () => {
    detectAllBrowsersMock.mockResolvedValue([
      {
        family: 'chrome',
        label: 'Google Chrome',
        cookiesPath: '/Users/someone/Library/.../Cookies',
        keychainService: 'Chrome Safe Storage',
        keychainAccount: 'Chrome',
        profiles: [{ name: 'Person 1', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    ])
    routeIdentityMock.mockReturnValue({ orcaProfileId: 'profile-a' })

    const handler = clientHostDetectHandler()

    await expect(handler({ sender: trustedSender() }, { environmentId: 'env-1' })).resolves.toEqual([
      {
        family: 'chrome',
        label: 'Google Chrome',
        profiles: [{ name: 'Person 1', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    ])
    expect(routeIdentityMock).toHaveBeenCalledWith('env-1')
  })

  it('returns null so detection falls back to the server when nothing is client-hosted', async () => {
    routeIdentityMock.mockReturnValue(null)

    const handler = clientHostDetectHandler()

    await expect(
      handler({ sender: trustedSender() }, { environmentId: 'env-1' })
    ).resolves.toBeNull()
    expect(detectAllBrowsersMock).not.toHaveBeenCalled()
  })

  it('forwards the user-agent mode from a trusted renderer', async () => {
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

    await expect(
      createHandler({ sender }, { scope: 'isolated', label: 'Google', userAgentMode: 'native' })
    ).resolves.toEqual(profile)
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

    const detected = (await detectHandler({ sender: trustedSender() })) as Record<string, unknown>[]

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
      { sender: trustedSender() },
      { profileId: 'default', browserFamily: 'custom', customBrowserId: 'com.operasoftware.Opera' }
    )

    expect(result).toMatchObject({ ok: true, profileId: 'default' })
    expect(importCookiesFromBrowserMock).toHaveBeenCalledWith(opera, 'persist:default')
    expect(updateProfileSourceMock).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ browserFamily: 'custom', profileName: 'Default' })
    )
  })

  it('refuses an ambiguous custom import when customBrowserId is omitted', async () => {
    getProfileMock.mockReturnValue({ id: 'default', partition: 'persist:default' })
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
    detectAllBrowsersMock.mockResolvedValue([vivaldi, opera])
    const importHandler = getHandler('browser:session:importFromBrowser')

    const result = await importHandler(
      { sender: trustedSender() },
      { profileId: 'default', browserFamily: 'custom' }
    )

    // Without a customBrowserId the shared 'custom' family can't identify one browser.
    expect(result).toMatchObject({ ok: false })
    expect(importCookiesFromBrowserMock).not.toHaveBeenCalled()
  })

  it('persists the browser name as sourceLabel when importing a custom browser', async () => {
    getProfileMock.mockReturnValue({ id: 'default', partition: 'persist:default' })
    importCookiesFromBrowserMock.mockResolvedValue({
      ok: true,
      summary: { totalCookies: 1, importedCookies: 1, skippedCookies: 0, domains: [] }
    })
    const aside = {
      family: 'custom',
      label: 'Aside',
      cookiesPath: '/aside/Cookies',
      profiles: [{ name: 'Default', directory: 'Default' }],
      selectedProfile: 'Default',
      customBrowserId: 'at.studio.AsideBrowser'
    }
    detectAllBrowsersMock.mockResolvedValue([aside])
    const importHandler = getHandler('browser:session:importFromBrowser')

    await importHandler(
      { sender: trustedSender() },
      { profileId: 'default', browserFamily: 'custom', customBrowserId: 'at.studio.AsideBrowser' }
    )

    expect(updateProfileSourceMock).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ browserFamily: 'custom', sourceLabel: 'Aside' })
    )
  })
})
