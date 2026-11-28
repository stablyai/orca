import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supportEnabled: false,
  unloadEverywhere: vi.fn<(extensionId: string) => Promise<void>>()
}))

vi.mock('./browser-extension-support', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBrowserExtensionSupportEnabled: () => mocks.supportEnabled
}))
vi.mock('../../telemetry/browser-extensions-banner', () => ({
  recordBrowserExtensionInstalled: vi.fn()
}))
vi.mock('./profile-sessions/browser-extension-idle-profiles', () => ({
  startBrowserExtensionsForSettings: vi.fn()
}))
vi.mock('../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: vi.fn(),
    getEnabledExtensionIds: vi.fn(() => []),
    updateEnabledExtensionIds: vi.fn()
  }
}))
vi.mock('./tabs-and-windows/browser-extension-options-page', () => ({
  openBrowserExtensionOptionsPage: vi.fn()
}))
vi.mock('./installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ get: vi.fn(), list: vi.fn(() => []), remove: vi.fn() })
}))
vi.mock('./profile-sessions/browser-extension-profile-reload', () => ({
  reloadBrowserExtensionWhereEnabled: vi.fn()
}))
vi.mock('./installation/browser-extension-manifest', () => ({
  readBrowserExtensionIconDataUrl: vi.fn(),
  readBrowserExtensionManifest: vi.fn()
}))
vi.mock('./profile-sessions/browser-extension-session-loader', () => ({
  getBrowserExtensionSessionForProfile: vi.fn(),
  listBrowserExtensionSessions: vi.fn(() => []),
  loadBrowserExtensionFolderIntoProfile: vi.fn(),
  loadBrowserExtensionIntoProfile: vi.fn(),
  unloadBrowserExtensionEverywhere: mocks.unloadEverywhere,
  unloadBrowserExtensionFromProfile: vi.fn(),
  whenBrowserExtensionProfileLoaded: vi.fn()
}))
vi.mock('./profile-storage/browser-extension-data-removal', () => ({
  clearBrowserExtensionSessionData: vi.fn()
}))
vi.mock('./web-store/browser-extension-held-updates', () => ({
  forgetHeldBrowserExtensionUpdate: vi.fn(),
  getHeldBrowserExtensionUpdate: vi.fn()
}))
vi.mock('./installation/browser-extension-load-directory', () => ({
  browserExtensionIdForUnpackedFolder: vi.fn(),
  forgetPreparedBrowserExtensionDirectory: vi.fn()
}))
vi.mock('./profile-sessions/browser-extension-load-errors', () => ({
  forgetBrowserExtensionLoadFailures: vi.fn(),
  getBrowserExtensionLoadFailure: vi.fn()
}))
vi.mock('./installation/browser-extension-list-changes', () => ({
  notifyBrowserExtensionListChanged: vi.fn()
}))
vi.mock('./web-store/browser-extension-webstore-updater', () => ({
  reviewHeldBrowserExtensionUpdate: vi.fn()
}))
vi.mock('./profile-sessions/browser-extension-profile-enablement', () => ({
  withExtensionEnabled: vi.fn(),
  withoutExtension: vi.fn()
}))
vi.mock('./actions/browser-extension-toolbar-pins', () => ({
  forgetPinnedBrowserExtension: vi.fn()
}))
vi.mock('./profile-storage/browser-extension-profile-state-store', () => ({
  getBrowserExtensionProfileStateStore: () => ({ forgetExtension: vi.fn() })
}))
vi.mock('./profile-storage/browser-extension-sync-storage-store', () => ({
  getBrowserExtensionSyncStorageStore: () => ({ forgetExtension: vi.fn() })
}))
vi.mock('./declarative-net-request/session/browser-extension-dnr-store', () => ({
  getBrowserExtensionDnrStore: () => ({ forgetExtension: vi.fn() })
}))
vi.mock('./profile-sessions/browser-extension-idle-kept-state', () => ({
  dropBrowserExtensionIdleState: vi.fn()
}))
vi.mock('./web-store/browser-extension-webstore-events', () => ({
  notifyChromeWebStoreUninstalled: vi.fn()
}))
vi.mock('./profile-sessions/browser-extension-route-profiles', () => ({
  browserExtensionSourceProfileId: (profileId: string) => profileId,
  loadBrowserExtensionWhereProfileRuns: vi.fn(),
  unloadBrowserExtensionFromRouteProfilesOf: vi.fn()
}))

const { removeBrowserExtension } = await import('./browser-extension-management')

describe('settle-backed Settings actions', () => {
  beforeEach(() => {
    mocks.supportEnabled = false
    mocks.unloadEverywhere.mockReset()
  })

  it('tags support turned off so the renderer can word it, keeping the English error', async () => {
    expect(await removeBrowserExtension('abc')).toEqual({
      ok: false,
      error: 'Turn on browser extensions in Settings › Browser › Extensions',
      failure: { reason: 'support-disabled' }
    })
  })

  it('leaves a thrown diagnostic untagged', async () => {
    mocks.supportEnabled = true
    mocks.unloadEverywhere.mockRejectedValue(new Error('disk full'))
    const result = await removeBrowserExtension('abc')
    expect(result).toEqual({ ok: false, error: 'disk full' })
    expect('failure' in result).toBe(false)
  })
})
