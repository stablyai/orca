import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, createProfileMock, routeIdentityMock, detectBrowsersMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    createProfileMock: vi.fn(),
    routeIdentityMock: vi.fn(),
    detectBrowsersMock: vi.fn(() => [])
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

vi.mock('../browser/browser-cookie-import', () => ({
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
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    createProfileMock.mockReset()
    routeIdentityMock.mockReset()
    detectBrowsersMock.mockReset()
    detectBrowsersMock.mockReturnValue([])
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
