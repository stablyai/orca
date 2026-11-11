import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  removeHandlerMock,
  createProfileMock,
  routeIdentityMock,
  detectBrowsersMock,
  setBrowserIdentityModeMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  createProfileMock: vi.fn(),
  routeIdentityMock: vi.fn(),
  detectBrowsersMock: vi.fn(() => []),
  setBrowserIdentityModeMock: vi.fn(async () => ({ ok: true }))
}))

vi.mock('../../browser/identity/mode/browser-identity-mode-store', () => ({
  setBrowserIdentityMode: setBrowserIdentityModeMock,
  getBrowserIdentityModeStatus: vi.fn(() => ({ identity: {}, migrationNotice: null }))
}))

vi.mock('./browser-passwords-ipc', () => ({ registerBrowserPasswordsHandlers: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock,
    on: vi.fn(),
    removeAllListeners: vi.fn()
  },
  webContents: { fromId: vi.fn() }
}))

vi.mock('../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserCertificateTrustController: { proceed: vi.fn() },
  browserManager: {
    cancelGrabOp: vi.fn(),
    getWebContentsIdByTabId: vi.fn(() => new Map())
  }
}))

vi.mock('../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    createProfile: createProfileMock
  }
}))

vi.mock('../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime', () => ({
  getPairedRuntimeBrowserClientRouteIdentity: routeIdentityMock
}))

vi.mock('../../browser/cookies/sources/browser-cookie-detection', () => ({
  detectInstalledBrowsers: detectBrowsersMock,
  selectBrowserProfile: vi.fn()
}))
vi.mock('../../browser/cookies/browser-cookie-import', () => ({
  importCookiesFromBrowser: vi.fn()
}))
vi.mock('../../browser/cookies/imports/import-cookie-file', () => ({
  importCookiesFromFile: vi.fn()
}))
vi.mock('../../browser/cookies/imports/cookie-file-picker', () => ({
  pickCookieFile: vi.fn()
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

  function identitySetHandler(): (
    event: { sender: Electron.WebContents },
    mode: unknown
  ) => Promise<unknown> {
    registerBrowserHandlers({ getSettings: vi.fn() })
    return handleMock.mock.calls.find(([channel]) => channel === 'browser:identity:set')?.[1]
  }

  // Unknown modes must reject consistently with RPC instead of silently selecting clean.
  it('refuses an unrecognized identity mode instead of silently selecting Cleaned', async () => {
    setTrustedBrowserRendererWebContentsId(91)
    const handler = identitySetHandler()

    await expect(handler({ sender: trustedSender() }, 'rotating')).rejects.toThrow(/rotating/)
    expect(setBrowserIdentityModeMock).not.toHaveBeenCalled()
  })

  function clientHostDetectHandler(): (
    event: { sender: Electron.WebContents },
    args: { environmentId: string }
  ) => unknown {
    registerBrowserHandlers({ getSettings: vi.fn() })
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
})
