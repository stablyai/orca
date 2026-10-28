import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  importCookieFileMock,
  handleMock,
  removeHandlerMock,
  createProfileMock,
  routeIdentityMock,
  detectBrowsersMock,
  setBrowserIdentityModeMock
} = vi.hoisted(() => ({
  importCookieFileMock: vi.fn(),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  createProfileMock: vi.fn(),
  routeIdentityMock: vi.fn(),
  detectBrowsersMock: vi.fn(() => []),
  setBrowserIdentityModeMock: vi.fn(async () => ({ ok: true }))
}))

vi.mock('../browser/browser-client-route-cookie-import', () => ({
  importCookieFileIntoClientRoutePartition: importCookieFileMock,
  importCookiesIntoClientRoutePartition: vi.fn()
}))

vi.mock('../browser/browser-identity-mode-store', () => ({
  setBrowserIdentityMode: setBrowserIdentityModeMock,
  getBrowserIdentityModeStatus: vi.fn(() => ({ identity: {}, migrationNotice: null }))
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

vi.mock('../browser/paired-runtime-browser-client-host-runtime', () => ({
  getPairedRuntimeBrowserClientRouteIdentity: routeIdentityMock
}))

vi.mock('../browser/cookies/browser-cookie-import', () => ({
  detectInstalledBrowsers: detectBrowsersMock,
  importCookiesFromBrowser: vi.fn(),
  importCookiesFromFile: vi.fn(),
  pickCookieFile: vi.fn(),
  selectBrowserProfile: vi.fn()
}))

import { registerBrowserHandlers } from './browser'
import { setTrustedBrowserRendererWebContentsId } from './browser-renderer-trust'

describe('browser session profile IPC', () => {
  beforeEach(() => {
    importCookieFileMock.mockReset()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    createProfileMock.mockReset()
    routeIdentityMock.mockReset()
    detectBrowsersMock.mockReset()
    detectBrowsersMock.mockReturnValue([])
    setBrowserIdentityModeMock.mockReset()
    setBrowserIdentityModeMock.mockResolvedValue({ ok: true })
    setTrustedBrowserRendererWebContentsId(91)
  })

  function trustedSender(): Electron.WebContents {
    return {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents
  }

  function manualImportHandler() {
    registerBrowserHandlers()
    return handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:session:importCookies'
    )?.[1]
  }

  it('routes manual imports to the named environment with a main-owned file picker', async () => {
    setTrustedBrowserRendererWebContentsId(91)
    importCookieFileMock.mockResolvedValue({ ok: false, reason: 'canceled' })
    const handler = manualImportHandler()
    expect(
      await handler({ sender: trustedSender() }, { profileId: 'default', environmentId: 'env-a' })
    ).toEqual({ ok: false, reason: 'canceled' })
    expect(importCookieFileMock).toHaveBeenCalledWith(
      { environmentId: 'env-a', browserProfileId: 'default' },
      expect.any(Function)
    )
  })

  it('does not fall through to a local profile when the environment is not client-hosted', async () => {
    setTrustedBrowserRendererWebContentsId(91)
    importCookieFileMock.mockResolvedValue(null)
    const handler = manualImportHandler()
    expect(
      await handler({ sender: trustedSender() }, { profileId: 'default', environmentId: 'env-a' })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('hosted on this device') })
  })

  it('rejects unauthorized manual environment imports', async () => {
    setTrustedBrowserRendererWebContentsId(92)
    const handler = manualImportHandler()
    expect(
      await handler({ sender: trustedSender() }, { profileId: 'default', environmentId: 'env-a' })
    ).toEqual({ ok: false, reason: 'Not authorized' })
    expect(importCookieFileMock).not.toHaveBeenCalled()
  })

  function identitySetHandler(): (
    event: { sender: Electron.WebContents },
    mode: unknown
  ) => Promise<unknown> {
    registerBrowserHandlers()
    return handleMock.mock.calls.find(([channel]) => channel === 'browser:identity:set')?.[1]
  }

  // Unknown modes must reject consistently with RPC instead of silently selecting clean.
  it('refuses an unrecognized identity mode instead of silently selecting Cleaned', async () => {
    setTrustedBrowserRendererWebContentsId(91)
    const handler = identitySetHandler()

    await expect(handler({ sender: trustedSender() }, 'rotating')).rejects.toThrow(/rotating/)
    expect(setBrowserIdentityModeMock).not.toHaveBeenCalled()
  })

  it('commits a recognized identity mode unchanged', async () => {
    setTrustedBrowserRendererWebContentsId(91)
    const handler = identitySetHandler()

    await expect(handler({ sender: trustedSender() }, 'native')).resolves.toEqual({ ok: true })
    expect(setBrowserIdentityModeMock).toHaveBeenCalledWith('native')
  })

  function clientHostDetectHandler(): (
    event: { sender: Electron.WebContents },
    args: { environmentId: string }
  ) => unknown {
    registerBrowserHandlers()
    return handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:session:detectBrowsersForClientHost'
    )?.[1]
  }

  // Client-hosted import must list browsers on this desktop, not the headless remote.
  it('detects this desktop’s browsers only while the environment is client-hosted', () => {
    detectBrowsersMock.mockReturnValue([
      {
        family: 'chrome',
        label: 'Google Chrome',
        cookiesPath: '/Users/someone/Library/.../Cookies',
        keychainService: 'Chrome Safe Storage',
        keychainAccount: 'Chrome',
        profiles: [{ name: 'Person 1', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    ] as never)
    routeIdentityMock.mockReturnValue({ orcaProfileId: 'profile-a' })

    const handler = clientHostDetectHandler()

    expect(handler({ sender: trustedSender() }, { environmentId: 'env-1' })).toEqual([
      {
        family: 'chrome',
        label: 'Google Chrome',
        profiles: [{ name: 'Person 1', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    ])
    expect(routeIdentityMock).toHaveBeenCalledWith('env-1')
  })

  it('returns null so detection falls back to the server when nothing is client-hosted', () => {
    routeIdentityMock.mockReturnValue(null)

    const handler = clientHostDetectHandler()

    expect(handler({ sender: trustedSender() }, { environmentId: 'env-1' })).toBeNull()
    expect(detectBrowsersMock).not.toHaveBeenCalled()
  })

  it('creates a profile for a trusted renderer', async () => {
    const profile = {
      id: 'profile-google',
      scope: 'isolated',
      partition: 'persist:orca-browser-session-profile-google',
      label: 'Google',
      source: null
    }
    createProfileMock.mockReturnValue(profile)
    registerBrowserHandlers()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registered test handler is selected by its exact channel and called with its declared boundary shape.
    const createHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:session:createProfile'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: { scope: 'isolated'; label: string }
    ) => unknown
    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    await expect(
      createHandler({ sender }, { scope: 'isolated', label: 'Google' })
    ).resolves.toEqual(profile)
    expect(createProfileMock).toHaveBeenCalledWith('isolated', 'Google')
  })
})
