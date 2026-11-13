import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WindowRecord = { options: unknown; url: string; script: string; destroyed: boolean }

const mocks = vi.hoisted(() => {
  const windows: WindowRecord[] = []
  return { windows, userData: '', readdir: vi.fn(), rm: vi.fn() }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  mocks.readdir.mockImplementation(fs.readdir)
  mocks.rm.mockImplementation(fs.rm)
  return { ...fs, readdir: mocks.readdir, rm: mocks.rm }
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
  noteBrowserExtensionStorageOpened,
  removeUninstalledBrowserExtensionData,
  removeReinstalledBrowserExtensionData
} = await import('./browser-extension-data-removal')
const { getBrowserExtensionProfileStateStore } =
  await import('./browser-extension-profile-state-store')
const { getBrowserExtensionSyncStorageStore } =
  await import('./browser-extension-sync-storage-store')
const { getBrowserExtensionInstallStore } =
  await import('../installation/browser-extension-install-store')

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

describe('uninstall while another Orca profile is inactive', () => {
  it('clears native and origin data and grants after uninstall and reinstall in another Orca profile', async () => {
    const personalDirectory = mkdtempSync(join(tmpdir(), 'orca-extension-personal-'))
    const workDirectory = mkdtempSync(join(tmpdir(), 'orca-extension-work-'))
    async function openOrcaProfile(directory: string) {
      vi.resetModules()
      const { configureBrowserExtensionProfileDataDirectory } =
        await import('./browser-extension-profile-data-directory')
      configureBrowserExtensionProfileDataDirectory(directory)
      const { getBrowserExtensionInstallStore } =
        await import('../installation/browser-extension-install-store')
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
    await personal.sync.flush()
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
    await reopened.sync.flush()
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
  await sync.flush()
})

it('records reinstall cleanup only after the old sync storage file is deleted', async () => {
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
  store.save(record)
  await store.remove(ID)
  store.save(record)
  const profileId = 'held-delete'
  const sync = getBrowserExtensionSyncStorageStore()
  const states = getBrowserExtensionProfileStateStore()
  sync.write(profileId, ID, { token: 'old secret' })
  await sync.flush()
  let releaseDelete: () => void = () => {}
  let deleteStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => (deleteStarted = resolve))
  const held = new Promise<void>((resolve) => (releaseDelete = resolve))
  mocks.rm.mockImplementation(async (...args: Parameters<typeof FsPromises.rm>) => {
    if (String(args[0]).endsWith(`${ID}.json`)) {
      deleteStarted()
      await held
    }
    return realFsPromises.rm(...args)
  })
  try {
    const cleanup = removeReinstalledBrowserExtensionData(fakeSession(false), profileId, ID)
    await started
    // A marker saved before the delete would skip it after a crash, bringing the old items back.
    expect(states.read(profileId, ID).removalGeneration).toBe(0)
    releaseDelete()
    await cleanup
    expect(states.read(profileId, ID).removalGeneration).toBeGreaterThan(0)
    expect(
      existsSync(
        join(mocks.userData, 'browser-extensions', 'sync-storage', profileId, `${ID}.json`)
      )
    ).toBe(false)
  } finally {
    releaseDelete()
    mocks.rm.mockImplementation(realFsPromises.rm)
  }
})
