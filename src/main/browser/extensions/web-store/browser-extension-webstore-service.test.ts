import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const EXTENSION_ID = 'a'.repeat(32)

type MockState = {
  supportEnabled: boolean
  profileExists: boolean
  installed: { name: string } | null
  enabledIds: string[]
  download: Mock<(extensionId: string) => Promise<unknown>>
}

const mocks = vi.hoisted((): MockState => ({
  supportEnabled: true,
  profileExists: true,
  installed: null,
  enabledIds: [],
  download: vi.fn<(extensionId: string) => Promise<unknown>>()
}))

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))
vi.mock('../browser-extension-support', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBrowserExtensionSupportEnabled: () => mocks.supportEnabled
}))
vi.mock('../profile-sessions/browser-extension-route-profiles', () => ({
  browserExtensionSourceProfileId: (profileId: string) => profileId
}))
vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({ browserManager: {} }))
vi.mock('../../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: () => (mocks.profileExists ? { id: 'default', label: 'Default' } : undefined),
    getEnabledExtensionIds: () => mocks.enabledIds
  }
}))
vi.mock('../installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ get: () => mocks.installed })
}))
vi.mock('../permissions/browser-extension-install-prompt', () => ({
  requestBrowserExtensionInstallPrompt: vi.fn()
}))
vi.mock('../browser-extension-management', () => ({ removeBrowserExtension: vi.fn() }))
vi.mock('../installation/browser-extension-manifest', () => ({
  readBrowserExtensionIconDataUrl: vi.fn()
}))
vi.mock('../permissions/browser-extension-permission-summary', () => ({
  samePermissionSummary: vi.fn()
}))
vi.mock('./browser-extension-webstore-download', () => ({
  downloadWebStoreCrx: mocks.download,
  fetchWebStoreIconDataUrl: vi.fn(),
  isAllowedWebStoreIconUrl: vi.fn()
}))
vi.mock('./browser-extension-webstore-events', () => ({
  notifyChromeWebStoreInstalled: vi.fn(),
  notifyChromeWebStoreUninstalled: vi.fn()
}))
vi.mock('../installation/browser-extension-webstore-install', () => ({
  commitStagedWebStoreExtension: vi.fn(),
  discardStagedWebStoreExtension: vi.fn(),
  stageWebStoreExtension: vi.fn()
}))
vi.mock('./browser-extension-webstore-install-flow', () => ({
  ChromeWebStoreInstallFlow: class {},
  InvalidIconUrlError: class extends Error {}
}))

const { installBrowserExtensionFromWebStore } = await import('./browser-extension-webstore-service')

// Only forwarded to the (mocked) install prompt, so no WebContents member is ever read.
const renderer: Electron.WebContents = Object.create(null)

function install(input = EXTENSION_ID): ReturnType<typeof installBrowserExtensionFromWebStore> {
  return installBrowserExtensionFromWebStore('default', input, renderer)
}

describe('Settings › Add from Chrome Web Store failures', () => {
  beforeEach(() => {
    mocks.supportEnabled = true
    mocks.profileExists = true
    mocks.installed = null
    mocks.enabledIds = []
    mocks.download.mockReset()
  })

  it('tags support turned off, keeping the English error', async () => {
    mocks.supportEnabled = false
    expect(await install()).toEqual({
      status: 'failed',
      error: 'Turn on browser extensions in Settings › Browser › Extensions',
      failure: { reason: 'support-disabled' }
    })
  })

  it('tags input that is neither a store link nor an extension ID', async () => {
    expect(await install('not a store link')).toEqual({
      status: 'failed',
      error: 'Paste a Chrome Web Store link or a 32-letter extension ID',
      failure: { reason: 'invalid-web-store-input' }
    })
  })

  it('tags a browser profile that is not available', async () => {
    mocks.profileExists = false
    expect(await install()).toEqual({
      status: 'failed',
      error: 'Browser profile is not available for extensions',
      failure: { reason: 'profile-unavailable' }
    })
  })

  it('tags an extension already added, carrying its name for the renderer', async () => {
    mocks.installed = { name: 'Foo: Bar' }
    mocks.enabledIds = [EXTENSION_ID]
    expect(await install()).toEqual({
      status: 'failed',
      error: 'Foo: Bar is already added',
      failure: { reason: 'already-added', name: 'Foo: Bar' }
    })
  })

  it('leaves a later download failure untagged', async () => {
    mocks.download.mockRejectedValue(new Error('Download is too large'))
    const result = await install()
    expect(result).toEqual({ status: 'failed', error: 'Download is too large' })
    expect('failure' in result).toBe(false)
  })
})
