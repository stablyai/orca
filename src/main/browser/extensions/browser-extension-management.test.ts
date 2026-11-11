import { beforeEach, describe, expect, it, vi } from 'vitest'

const ID = 'nngceckbapebfimnlniiiahkandclblb'

const mocks = vi.hoisted(() => {
  const records = new Map<string, Record<string, unknown>>()
  return {
    records,
    forgetDnrState: vi.fn(),
    sessions: [{ name: 'default' }, { name: 'work' }],
    store: {
      get: (id: string) => records.get(id) ?? null,
      save: vi.fn((record: Record<string, unknown>) => records.set(String(record.id), record)),
      remove: vi.fn(async (id: string) => records.delete(id))
    }
  }
})

vi.mock('../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    getEnabledExtensionIds: () => [],
    updateEnabledExtensionIds: vi.fn(),
    getProfile: () => ({ id: 'default' })
  }
}))
vi.mock('./tabs-and-windows/browser-extension-options-page', () => ({
  openBrowserExtensionOptionsPage: vi.fn()
}))
vi.mock('./installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => mocks.store
}))
vi.mock('./profile-sessions/browser-extension-profile-reload', () => ({
  reloadBrowserExtensionWhereEnabled: vi.fn()
}))
vi.mock('./installation/browser-extension-manifest', () => ({
  readBrowserExtensionIconDataUrl: async () => null,
  readBrowserExtensionManifest: async () => ({
    name: 'Dev copy',
    version: '1.0',
    iconPath: null,
    permissions: [],
    hostPermissions: [],
    optionsPage: null
  })
}))
vi.mock('./profile-sessions/browser-extension-session-loader', () => ({
  getBrowserExtensionSessionForProfile: vi.fn(),
  listBrowserExtensionSessions: () => mocks.sessions,
  loadBrowserExtensionFolderIntoProfile: vi.fn(async () => ({ id: ID, version: '1.0' })),
  loadBrowserExtensionIntoProfile: vi.fn(),
  unloadBrowserExtensionEverywhere: vi.fn(),
  unloadBrowserExtensionFromProfile: vi.fn()
}))
vi.mock('./profile-storage/browser-extension-data-removal', () => ({
  clearBrowserExtensionSessionData: vi.fn(async () => {})
}))
vi.mock('./installation/browser-extension-load-directory', () => ({
  browserExtensionIdForUnpackedFolder: async () => ID
}))
vi.mock('./web-store/browser-extension-webstore-updater', () => ({
  reviewHeldBrowserExtensionUpdate: vi.fn()
}))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
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
  getBrowserExtensionDnrStore: () => ({ forgetExtension: mocks.forgetDnrState })
}))
vi.mock('./web-store/browser-extension-webstore-events', () => ({
  notifyChromeWebStoreUninstalled: vi.fn()
}))

const loader = await import('./profile-sessions/browser-extension-session-loader')
await import('./profile-storage/browser-extension-data-removal')
const { addUnpackedBrowserExtension, removeBrowserExtension } =
  await import('./browser-extension-management')
await import('./installation/browser-extension-webstore-install')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.records.clear()
})

describe('addUnpackedBrowserExtension', () => {
  it('records new install metadata before native load and rolls it back if loading fails', async () => {
    vi.mocked(loader.loadBrowserExtensionFolderIntoProfile).mockImplementationOnce(async () => {
      expect(mocks.records.get(ID)).toMatchObject({ id: ID, version: '1.0', source: 'unpacked' })
      throw new Error('native load failed')
    })
    expect(await addUnpackedBrowserExtension('default', '/dev/vault')).toEqual({
      ok: false,
      error: 'native load failed'
    })
    expect(mocks.records.has(ID)).toBe(false)
  })

  it('holds off a removal until its load is recorded, so removal cannot be undone', async () => {
    let finishLoad = (): void => {}
    vi.mocked(loader.loadBrowserExtensionFolderIntoProfile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: management reads only id and version.
          finishLoad = () => resolve({ id: ID, version: '1.0' } as Electron.Extension)
        })
    )
    const adding = addUnpackedBrowserExtension('default', '/dev/vault')
    await vi.waitFor(() => expect(loader.loadBrowserExtensionFolderIntoProfile).toHaveBeenCalled())
    expect(await removeBrowserExtension(ID)).toMatchObject({ ok: false })
    finishLoad()
    expect(await adding).toEqual({ ok: true })
    expect(mocks.store.remove).not.toHaveBeenCalled()
  })
})
