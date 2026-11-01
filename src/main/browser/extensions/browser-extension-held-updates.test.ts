import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ID = 'nngceckbapebfimnlniiiahkandclblb'

type Access = { permissions: string[]; hostPermissions: string[] }

const mocks = vi.hoisted(() => {
  const stagedAccess: Access = { permissions: [], hostPermissions: [] }
  return { stagedAccess, stagedVersion: '2.0', accepted: true, installedPath: '' }
})

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  net: {
    fetch: async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          response: {
            app: [
              {
                appid: ID,
                updatecheck: {
                  status: 'ok',
                  urls: { url: [{ codebase: 'https://clients2.googleusercontent.com/crx/' }] },
                  manifest: { version: '2.0', packages: { package: [{ name: 'vault.crx' }] } }
                }
              }
            ]
          }
        })
    })
  }
}))
vi.mock('./browser-extension-webstore-download', () => ({
  downloadWebStoreCrx: vi.fn(async () => ({})),
  isAllowedCrxDownloadUrl: () => true
}))
vi.mock('./browser-extension-webstore-install', () => ({
  stageWebStoreExtension: vi.fn(async () => ({
    extensionId: ID,
    version: mocks.stagedVersion,
    directory: '/staging',
    access: mocks.stagedAccess
  })),
  discardStagedWebStoreExtension: vi.fn(async () => {}),
  commitStagedWebStoreExtension: vi.fn(async () => ({})),
  isBrowserExtensionBusy: () => false,
  withBrowserExtensionLock: (_id: string, action: () => Promise<unknown>) => action()
}))
vi.mock('./browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => {
    const installed = {
      id: ID,
      name: 'Vault',
      version: '1.0',
      path: mocks.installedPath,
      source: 'webstore',
      iconPath: null
    }
    return { list: () => [installed], get: () => installed }
  }
}))
vi.mock('./browser-extension-install-prompt', () => ({
  requestBrowserExtensionInstallPrompt: vi.fn(async () => mocks.accepted)
}))
vi.mock('./browser-extension-manifest', () => ({
  readBrowserExtensionIconDataUrl: async () => null
}))

const install = await import('./browser-extension-webstore-install')
await import('./browser-extension-install-prompt')
const { checkForBrowserExtensionUpdates, reviewHeldBrowserExtensionUpdate } =
  await import('./browser-extension-webstore-updater')
const held = await import('./browser-extension-held-updates')
const { setBrowserExtensionSupportEnabled } = await import('./browser-extension-support')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt is mocked, so the renderer is only passed through.
const renderer = {} as Electron.WebContents

mocks.installedPath = mkdtempSync(join(tmpdir(), 'orca-held-update-'))
writeFileSync(
  join(mocks.installedPath, 'manifest.json'),
  JSON.stringify({
    version: '1.0',
    permissions: ['storage', 'tabs'],
    host_permissions: ['https://vault.example/*']
  })
)

beforeEach(() => {
  vi.clearAllMocks()
  setBrowserExtensionSupportEnabled(true)
  held.forgetHeldBrowserExtensionUpdate(ID)
  mocks.accepted = true
  mocks.stagedVersion = '2.0'
})

describe('store updates that ask for more', () => {
  it('holds an update with new warnings and records only the new ones', async () => {
    mocks.stagedAccess = {
      permissions: ['history', 'storage', 'tabs'],
      hostPermissions: ['<all_urls>']
    }
    await checkForBrowserExtensionUpdates()
    expect(install.commitStagedWebStoreExtension).not.toHaveBeenCalled()
    expect(install.discardStagedWebStoreExtension).toHaveBeenCalledOnce()
    expect(held.getHeldBrowserExtensionUpdate(ID)).toMatchObject({
      version: '2.0',
      newWarnings: { permissions: ['history'], hostPermissions: ['<all_urls>'] }
    })

    // The next check does not download the same held version again.
    await checkForBrowserExtensionUpdates()
    expect(install.stageWebStoreExtension).toHaveBeenCalledOnce()
  })

  it('keeps the update held when the user declines', async () => {
    mocks.stagedAccess = { permissions: ['history'], hostPermissions: [] }
    await checkForBrowserExtensionUpdates()
    mocks.accepted = false
    await reviewHeldBrowserExtensionUpdate(ID, renderer)
    expect(install.commitStagedWebStoreExtension).not.toHaveBeenCalled()
    expect(held.getHeldBrowserExtensionUpdate(ID)).not.toBeNull()
  })

  it('refuses a package that changed since it was held', async () => {
    mocks.stagedAccess = { permissions: ['history'], hostPermissions: [] }
    await checkForBrowserExtensionUpdates()
    mocks.stagedAccess = { permissions: ['history', 'bookmarks'], hostPermissions: [] }
    await expect(reviewHeldBrowserExtensionUpdate(ID, renderer)).rejects.toThrow(/changed/)
    expect(install.commitStagedWebStoreExtension).not.toHaveBeenCalled()
    expect(held.getHeldBrowserExtensionUpdate(ID)).toBeNull()
  })
})
