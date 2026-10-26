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

vi.mock('../browser-session-registry', () => ({
  browserSessionRegistry: {
    getEnabledExtensionIds: () => [],
    updateEnabledExtensionIds: vi.fn(),
    getProfile: () => ({ id: 'default' })
  }
}))
vi.mock('./api/runtime', () => ({ openBrowserExtensionOptionsPage: vi.fn() }))
vi.mock('./browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => mocks.store
}))
vi.mock('./browser-extension-profile-reload', () => ({
  reloadBrowserExtensionWhereEnabled: vi.fn()
}))
vi.mock('./browser-extension-manifest', () => ({
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
vi.mock('./browser-extension-session-loader', () => ({
  getBrowserExtensionSessionForProfile: vi.fn(),
  listBrowserExtensionSessions: () => mocks.sessions,
  loadBrowserExtensionFolderIntoProfile: vi.fn(async () => ({ id: ID, version: '1.0' })),
  loadBrowserExtensionIntoProfile: vi.fn(),
  unloadBrowserExtensionEverywhere: vi.fn(),
  unloadBrowserExtensionFromProfile: vi.fn()
}))
vi.mock('./browser-extension-data-removal', () => ({
  clearBrowserExtensionSessionData: vi.fn(async () => {})
}))
vi.mock('./browser-extension-load-directory', () => ({
  browserExtensionIdForUnpackedFolder: async () => ID
}))
vi.mock('./browser-extension-webstore-updater', () => ({
  reviewHeldBrowserExtensionUpdate: vi.fn()
}))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('./browser-extension-toolbar-pins', () => ({ forgetPinnedBrowserExtension: vi.fn() }))
vi.mock('./browser-extension-profile-state-store', () => ({
  getBrowserExtensionProfileStateStore: () => ({ forgetExtension: vi.fn() })
}))
vi.mock('./browser-extension-sync-storage-store', () => ({
  getBrowserExtensionSyncStorageStore: () => ({ forgetExtension: vi.fn() })
}))
vi.mock('./browser-extension-dnr-store', () => ({
  getBrowserExtensionDnrStore: () => ({ forgetExtension: mocks.forgetDnrState })
}))
vi.mock('./browser-extension-webstore-events', () => ({
  notifyChromeWebStoreUninstalled: vi.fn()
}))

const loader = await import('./browser-extension-session-loader')
const { clearBrowserExtensionSessionData } = await import('./browser-extension-data-removal')
const {
  addUnpackedBrowserExtension,
  reloadUnpackedBrowserExtension,
  removeBrowserExtension,
  setBrowserExtensionEnabled
} = await import('./browser-extension-management')
const { withBrowserExtensionLock } = await import('./browser-extension-webstore-install')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.records.clear()
})

describe('removeBrowserExtension', () => {
  it("clears its data in every profile session before unloading it, then forgets Orca's record", async () => {
    mocks.records.set(ID, { id: ID, name: 'Vault', source: 'webstore' })
    expect(await removeBrowserExtension(ID)).toEqual({ ok: true })
    expect(loader.unloadBrowserExtensionEverywhere).toHaveBeenCalledWith(ID)
    expect(vi.mocked(clearBrowserExtensionSessionData).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(loader.unloadBrowserExtensionEverywhere).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(clearBrowserExtensionSessionData).mock.calls).toEqual([
      [mocks.sessions[0], ID],
      [mocks.sessions[1], ID]
    ])
    expect(mocks.store.remove).toHaveBeenCalledWith(ID)
    expect(mocks.forgetDnrState).toHaveBeenCalledWith(ID)
  })

  it('refuses while an install or update of the same extension is running', async () => {
    mocks.records.set(ID, { id: ID, name: 'Vault', source: 'webstore' })
    let finishUpdate = (): void => {}
    const update = withBrowserExtensionLock(
      ID,
      () => new Promise<void>((resolve) => (finishUpdate = resolve))
    )
    expect(await removeBrowserExtension(ID)).toEqual({
      ok: false,
      error: 'This extension is already being installed or removed'
    })
    expect(mocks.store.remove).not.toHaveBeenCalled()
    finishUpdate()
    await update
  })

  it('still removes the extension when one profile cannot clear its data', async () => {
    vi.mocked(clearBrowserExtensionSessionData).mockRejectedValueOnce(new Error('EBUSY'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await removeBrowserExtension(ID)).toEqual({ ok: true })
    expect(mocks.store.remove).toHaveBeenCalledWith(ID)
  })
})

describe('addUnpackedBrowserExtension', () => {
  it('refuses a folder whose id is a store install before loading or copying anything', async () => {
    mocks.records.set(ID, { id: ID, name: 'Vault', source: 'webstore' })
    expect(await addUnpackedBrowserExtension('default', '/dev/vault')).toEqual({
      ok: false,
      error: 'Vault is already installed from the Chrome Web Store'
    })
    expect(loader.loadBrowserExtensionFolderIntoProfile).not.toHaveBeenCalled()
    expect(mocks.store.save).not.toHaveBeenCalled()
  })

  it('loads and records a folder with a new id', async () => {
    expect(await addUnpackedBrowserExtension('default', '/dev/vault')).toEqual({ ok: true })
    expect(loader.loadBrowserExtensionFolderIntoProfile).toHaveBeenCalledWith(
      'default',
      ID,
      '/dev/vault',
      { refresh: true }
    )
    expect(mocks.records.get(ID)).toMatchObject({ source: 'unpacked', path: '/dev/vault' })
  })

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

  it('adds an installed folder to another profile without re-copying the copy others run', async () => {
    mocks.records.set(ID, { id: ID, name: 'Dev copy', source: 'unpacked', path: '/dev/vault' })
    expect(await addUnpackedBrowserExtension('work', '/dev/vault')).toEqual({ ok: true })
    expect(loader.loadBrowserExtensionFolderIntoProfile).toHaveBeenCalledWith(
      'work',
      ID,
      '/dev/vault',
      { refresh: false }
    )
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

describe('reloadUnpackedBrowserExtension', () => {
  it('refuses while a removal of the same extension is running, so it cannot restore it', async () => {
    mocks.records.set(ID, { id: ID, name: 'Dev copy', source: 'unpacked', path: '/dev/vault' })
    let finishRemoval = (): void => {}
    const removal = withBrowserExtensionLock(
      ID,
      () => new Promise<void>((resolve) => (finishRemoval = resolve))
    )
    expect(await reloadUnpackedBrowserExtension(ID)).toMatchObject({ ok: false })
    expect(mocks.store.save).not.toHaveBeenCalled()
    finishRemoval()
    await removal
  })
})

describe('setBrowserExtensionEnabled', () => {
  it('disables immediately while an enable still holds the install lock', async () => {
    mocks.records.set(ID, { id: ID, name: 'Vault', version: '1', source: 'webstore' })
    let finishLoad = (): void => {}
    vi.mocked(loader.loadBrowserExtensionIntoProfile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: management does not read the loaded extension.
          finishLoad = () => resolve({ id: ID } as Electron.Extension)
        })
    )
    const enabling = setBrowserExtensionEnabled('work', ID, true)
    await vi.waitFor(() => expect(loader.loadBrowserExtensionIntoProfile).toHaveBeenCalled())
    try {
      expect(await setBrowserExtensionEnabled('work', ID, false)).toEqual({ ok: true })
      expect(loader.unloadBrowserExtensionFromProfile).toHaveBeenCalledWith('work', ID)
    } finally {
      finishLoad()
      await enabling
    }
  })
})
