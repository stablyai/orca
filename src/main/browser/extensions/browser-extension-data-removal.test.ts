import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WindowRecord = { options: unknown; url: string; script: string; destroyed: boolean }

const mocks = vi.hoisted(() => {
  const windows: WindowRecord[] = []
  return { windows, userData: '', readdir: vi.fn() }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  mocks.readdir.mockImplementation(fs.readdir)
  return { ...fs, readdir: mocks.readdir }
})

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, on: vi.fn() },
  BrowserWindow: class {
    private readonly record
    readonly webContents
    constructor(options: unknown) {
      this.record = { options, url: '', script: '', destroyed: false }
      mocks.windows.push(this.record)
      this.webContents = {
        executeJavaScript: async (script: string) => {
          this.record.script = script
        }
      }
    }
    async loadURL(url: string): Promise<void> {
      this.record.url = url
    }
    destroy(): void {
      this.record.destroyed = true
    }
  }
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-data-user-'))

const {
  clearBrowserExtensionSessionData,
  noteBrowserExtensionStorageOpened,
  removeUninstalledBrowserExtensionData,
  removeReinstalledBrowserExtensionData,
  throwIfBrowserExtensionStorageAwaitingRestart
} = await import('./browser-extension-data-removal')
const { getBrowserExtensionProfileStateStore } =
  await import('./browser-extension-profile-state-store')
const { BrowserExtensionSyncStorageStore, getBrowserExtensionSyncStorageStore } =
  await import('./browser-extension-sync-storage-store')
const { getBrowserExtensionInstallStore } = await import('./browser-extension-install-store')
const { getBrowserExtensionProfileDataDirectory } =
  await import('./browser-extension-profile-data-directory')

const realFsPromises = await vi.importActual<typeof FsPromises>('node:fs/promises')

const ID = 'nngceckbapebfimnlniiiahkandclblb'
const OTHER = 'ddkjiahejlhfcafbddmgiahcphecmpfh'

function fakeSession(loaded: boolean, storagePath: string | null = null): Electron.Session {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test calls only these members.
  return {
    getStoragePath: () => storagePath,
    clearStorageData: vi.fn(async () => {}),
    extensions: { getExtension: () => (loaded ? { id: ID } : null) }
  } as unknown as Electron.Session
}

beforeEach(() => {
  mocks.windows.length = 0
})

describe('clearBrowserExtensionSessionData', () => {
  it("clears chrome.storage through a hidden page of the loaded extension, then its origin's data", async () => {
    const sess = fakeSession(true)
    await clearBrowserExtensionSessionData(sess, ID)
    expect(mocks.windows).toHaveLength(1)
    expect(mocks.windows[0]).toMatchObject({
      options: { show: false, webPreferences: { session: sess } },
      url: `chrome-extension://${ID}/manifest.json?orca-native-page=1`,
      destroyed: true
    })
    expect(mocks.windows[0].script).toContain('storage?.local?.clear()')
    expect(mocks.windows[0].script).toContain('storage?.session?.clear()')
    expect(sess.clearStorageData).toHaveBeenCalledExactlyOnceWith({
      origin: `chrome-extension://${ID}`
    })
  })

  it('deletes chrome.storage.local of an unloaded extension unless this run opened it', async () => {
    const partition = mkdtempSync(join(tmpdir(), 'orca-extension-data-'))
    const folder = join(partition, 'Local Extension Settings', ID)
    mkdirSync(folder, { recursive: true })
    const opened = fakeSession(false, partition)
    noteBrowserExtensionStorageOpened(opened, ID)
    await clearBrowserExtensionSessionData(opened, ID)
    // Chromium still holds the open database, so the launch sweep deletes it instead.
    expect(existsSync(folder)).toBe(true)
    expect(() => throwIfBrowserExtensionStorageAwaitingRestart(opened, ID)).toThrow('Restart Orca')

    const sess = fakeSession(false, partition)
    await clearBrowserExtensionSessionData(sess, ID)
    expect(existsSync(folder)).toBe(false)
    expect(mocks.windows).toHaveLength(0)
    expect(sess.clearStorageData).toHaveBeenCalledOnce()
  })

  it('blocks a same-run reinstall even when native data was cleared before a late write', async () => {
    const partition = mkdtempSync(join(tmpdir(), 'orca-extension-data-rewrite-'))
    const folder = join(partition, 'Local Extension Settings', ID)
    mkdirSync(folder, { recursive: true })
    let loaded = true
    const sess = fakeSession(true, partition)
    vi.spyOn(sess.extensions, 'getExtension').mockImplementation(() =>
      loaded ? { id: ID, name: 'Vault', version: '1', path: '', url: '', manifest: {} } : null
    )
    noteBrowserExtensionStorageOpened(sess, ID)
    await clearBrowserExtensionSessionData(sess, ID)
    // Another profile is still clearing, so the original extension has not unloaded yet.
    loaded = false
    await removeUninstalledBrowserExtensionData(sess, 'rewritten', new Set())
    expect(existsSync(join(folder, 'orca-uninstalled'))).toBe(true)
    expect(() => throwIfBrowserExtensionStorageAwaitingRestart(sess, ID)).toThrow('Restart Orca')
    const nextLaunch = fakeSession(false, partition)
    await removeUninstalledBrowserExtensionData(nextLaunch, 'rewritten', new Set([ID]))
    expect(existsSync(folder)).toBe(false)
    expect(() => throwIfBrowserExtensionStorageAwaitingRestart(nextLaunch, ID)).not.toThrow()
  })

  it('touches nothing for an id that is not a Chrome extension id', async () => {
    const sess = fakeSession(true)
    await expect(clearBrowserExtensionSessionData(sess, '..')).rejects.toThrow()
    expect(mocks.windows).toHaveLength(0)
    expect(sess.clearStorageData).not.toHaveBeenCalled()
  })
})

describe('removeUninstalledBrowserExtensionData', () => {
  it('deletes only the storage folders of extensions that are no longer installed', async () => {
    const partition = mkdtempSync(join(tmpdir(), 'orca-extension-data-'))
    const settings = join(partition, 'Local Extension Settings')
    for (const folder of [join(settings, ID), join(settings, OTHER), join(settings, 'notes')]) {
      mkdirSync(folder, { recursive: true })
    }
    mkdirSync(join(partition, 'IndexedDB'))
    await removeUninstalledBrowserExtensionData(
      fakeSession(false, partition),
      'default',
      new Set([OTHER])
    )
    expect(existsSync(join(settings, ID))).toBe(false)
    expect(existsSync(join(settings, OTHER))).toBe(true)
    expect(existsSync(join(settings, 'notes'))).toBe(true)
    expect(existsSync(join(partition, 'IndexedDB'))).toBe(true)
  })

  it('does nothing for an in-memory session or a partition without the folder', async () => {
    await expect(
      removeUninstalledBrowserExtensionData(fakeSession(false), 'default', new Set())
    ).resolves.toEqual(new Set())
    const empty = mkdtempSync(join(tmpdir(), 'orca-extension-data-'))
    await expect(
      removeUninstalledBrowserExtensionData(fakeSession(false, empty), 'default', new Set())
    ).resolves.toEqual(new Set())
  })

  it('deletes storage left open at uninstall at the next launch, even if reinstalled since', async () => {
    const partition = mkdtempSync(join(tmpdir(), 'orca-extension-data-'))
    const folder = join(partition, 'Local Extension Settings', ID)
    mkdirSync(folder, { recursive: true })
    const thisRun = fakeSession(false, partition)
    noteBrowserExtensionStorageOpened(thisRun, ID)
    await clearBrowserExtensionSessionData(thisRun, ID)

    await removeUninstalledBrowserExtensionData(thisRun, 'default', new Set())
    expect(existsSync(folder)).toBe(true)
    await removeUninstalledBrowserExtensionData(
      fakeSession(false, partition),
      'default',
      new Set([ID])
    )
    expect(existsSync(folder)).toBe(false)
  })

  // Uninstall reaches only the Orca profile open at the time; others are swept when they attach.
  it("forgets this profile's saved grants and sync items of uninstalled extensions", async () => {
    const states = getBrowserExtensionProfileStateStore()
    const sync = getBrowserExtensionSyncStorageStore()
    for (const id of [ID, OTHER]) {
      states.update('work', id, (state) => ({ ...state, grantedPermissions: ['nativeMessaging'] }))
      sync.write('work', id, { token: 'secret' })
    }
    sync.flush()
    states.update('home', ID, (state) => ({ ...state, grantedPermissions: ['tabs'] }))

    await removeUninstalledBrowserExtensionData(fakeSession(false), 'work', new Set([OTHER]))
    expect(Object.keys(states.readProfile('work'))).toEqual([OTHER])
    expect(states.read('home', ID).grantedPermissions).toEqual(['tabs'])
    expect(
      new BrowserExtensionSyncStorageStore(getBrowserExtensionProfileDataDirectory()).read(
        'work',
        ID
      )
    ).toEqual({})
    expect(sync.read('work', OTHER)).toEqual({ token: 'secret' })
  })
})

describe('uninstall while another Orca profile is inactive', () => {
  it('clears native and origin data and grants after uninstall and reinstall in another Orca profile', async () => {
    const personalDirectory = mkdtempSync(join(tmpdir(), 'orca-extension-personal-'))
    const workDirectory = mkdtempSync(join(tmpdir(), 'orca-extension-work-'))
    async function openOrcaProfile(directory: string) {
      vi.resetModules()
      const { configureBrowserExtensionProfileDataDirectory } =
        await import('./browser-extension-profile-data-directory')
      configureBrowserExtensionProfileDataDirectory(directory)
      const { getBrowserExtensionInstallStore } = await import('./browser-extension-install-store')
      const { getBrowserExtensionProfileStateStore } =
        await import('./browser-extension-profile-state-store')
      const { getBrowserExtensionSyncStorageStore } =
        await import('./browser-extension-sync-storage-store')
      const { removeUninstalledBrowserExtensionData } =
        await import('./browser-extension-data-removal')
      return {
        installed: getBrowserExtensionInstallStore(),
        states: getBrowserExtensionProfileStateStore(),
        sync: getBrowserExtensionSyncStorageStore(),
        sweep: removeUninstalledBrowserExtensionData
      }
    }
    const personal = await openOrcaProfile(personalDirectory)
    const record = {
      id: ID,
      name: 'Vault',
      version: '1',
      path: personal.installed.installDirectory(ID, '1'),
      source: 'webstore' as const,
      iconPath: null,
      permissions: [],
      hostPermissions: [],
      optionsPage: null
    }
    const partition = mkdtempSync(join(tmpdir(), 'orca-extension-inactive-'))
    const nativeSettings = join(partition, 'Local Extension Settings', ID)
    mkdirSync(nativeSettings, { recursive: true })
    personal.states.update('default', ID, (state) => ({
      ...state,
      grantedPermissions: ['nativeMessaging']
    }))
    personal.sync.write('default', ID, { token: 'old secret' })
    personal.states.flush()
    personal.sync.flush()
    personal.installed.save(record)

    const work = await openOrcaProfile(workDirectory)
    await work.installed.remove(ID)
    work.installed.save({ ...record, version: '2' })

    const reopened = await openOrcaProfile(personalDirectory)
    const sess = fakeSession(false, partition)
    await reopened.sweep(sess, 'default', new Set([ID]))
    expect(reopened.sync.read('default', ID)).toEqual({})
    expect(reopened.states.read('default', ID).grantedPermissions).toEqual([])
    expect(existsSync(nativeSettings)).toBe(false)
    expect(sess.clearStorageData).toHaveBeenCalledWith({ origin: `chrome-extension://${ID}` })

    reopened.sync.write('default', ID, { token: 'new secret' })
    await reopened.sweep(sess, 'default', new Set([ID]))
    expect(reopened.sync.read('default', ID)).toEqual({ token: 'new secret' })
    reopened.sync.flush()
  })

  it('clears origin-only storage with no chrome.storage.local folder', async () => {
    const store = getBrowserExtensionInstallStore()
    store.save({
      id: OTHER,
      name: 'Origin only',
      version: '1',
      path: store.installDirectory(OTHER, '1'),
      source: 'webstore',
      iconPath: null,
      permissions: [],
      hostPermissions: [],
      optionsPage: null
    })
    await store.remove(OTHER)
    const sess = fakeSession(false, mkdtempSync(join(tmpdir(), 'orca-extension-origin-')))
    await removeUninstalledBrowserExtensionData(sess, 'inactive-origin', new Set())
    expect(sess.clearStorageData).toHaveBeenCalledWith({ origin: `chrome-extension://${OTHER}` })
  })
})

it('preserves newly opened native settings while another extension finishes reinstall cleanup', async () => {
  const store = getBrowserExtensionInstallStore()
  const record = {
    id: ID,
    name: 'Vault',
    version: '1',
    path: store.installDirectory(ID, '1'),
    source: 'webstore' as const,
    iconPath: null,
    permissions: [],
    hostPermissions: [],
    optionsPage: null
  }
  for (const id of [ID, OTHER]) {
    store.save({ ...record, id })
    await store.remove(id)
    store.save({ ...record, id })
  }
  const partition = mkdtempSync(join(tmpdir(), 'orca-extension-concurrent-cleanup-'))
  const settings = join(partition, 'Local Extension Settings')
  mkdirSync(join(settings, ID), { recursive: true })
  mkdirSync(join(settings, OTHER), { recursive: true })
  let releaseFirst: () => void = () => {}
  let releaseSecond: () => void = () => {}
  let firstStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => (firstStarted = resolve))
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve))
  const sess = fakeSession(false, partition)
  let clears = 0
  vi.mocked(sess.clearStorageData).mockImplementation(async () => {
    clears++
    firstStarted()
    await (clears <= 2 ? firstGate : secondGate)
  })
  // Both sweeps receive the same pre-load directory snapshot, while deletion stays real.
  mocks.readdir.mockResolvedValue([ID, OTHER])
  const first = removeUninstalledBrowserExtensionData(sess, 'concurrent', new Set([ID, OTHER]))
  const second = removeUninstalledBrowserExtensionData(sess, 'concurrent', new Set([ID, OTHER]))
  try {
    await started
    releaseFirst()
    await first
    mkdirSync(join(settings, ID), { recursive: true })
    noteBrowserExtensionStorageOpened(sess, ID)
    releaseSecond()
    await second
    expect(existsSync(join(settings, ID))).toBe(true)
  } finally {
    releaseFirst()
    releaseSecond()
    await Promise.allSettled([first, second])
    mocks.readdir.mockImplementation(realFsPromises.readdir)
  }
})

it("preserves another pending unpacked reinstall's data when reconciling one extension", async () => {
  const store = getBrowserExtensionInstallStore()
  for (const id of [ID, OTHER]) {
    store.save({
      id,
      name: 'Unpacked',
      version: '1',
      path: join(tmpdir(), id),
      source: 'unpacked',
      iconPath: null,
      permissions: [],
      hostPermissions: [],
      optionsPage: null
    })
    await store.remove(id)
  }
  const partition = mkdtempSync(join(tmpdir(), 'orca-extension-pending-reinstall-'))
  const sess = fakeSession(false, partition)
  const profileId = 'pending-reinstalls'
  await removeReinstalledBrowserExtensionData(sess, profileId, ID)
  const nativeSettings = join(partition, 'Local Extension Settings', ID)
  mkdirSync(nativeSettings, { recursive: true })
  noteBrowserExtensionStorageOpened(sess, ID)
  const sync = getBrowserExtensionSyncStorageStore()
  const states = getBrowserExtensionProfileStateStore()
  sync.write(profileId, ID, { token: 'fresh secret' })
  states.update(profileId, ID, (state) => ({ ...state, grantedPermissions: ['tabs'] }))
  vi.mocked(sess.clearStorageData).mockClear()

  await removeReinstalledBrowserExtensionData(sess, profileId, OTHER)

  expect(sync.read(profileId, ID)).toEqual({ token: 'fresh secret' })
  expect(states.read(profileId, ID).grantedPermissions).toEqual(['tabs'])
  expect(existsSync(join(nativeSettings, 'orca-uninstalled'))).toBe(false)
  expect(sess.clearStorageData).toHaveBeenCalledExactlyOnceWith({
    origin: `chrome-extension://${OTHER}`
  })
  sync.flush()
})
