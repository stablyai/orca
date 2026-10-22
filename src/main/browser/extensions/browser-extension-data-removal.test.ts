import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WindowRecord = { options: unknown; url: string; script: string; destroyed: boolean }

const mocks = vi.hoisted(() => {
  const windows: WindowRecord[] = []
  return { windows, userData: '' }
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
  removeUninstalledBrowserExtensionData
} = await import('./browser-extension-data-removal')
const { getBrowserExtensionProfileStateStore } =
  await import('./browser-extension-profile-state-store')
const { BrowserExtensionSyncStorageStore, getBrowserExtensionSyncStorageStore } =
  await import('./browser-extension-sync-storage-store')
const { getBrowserExtensionProfileDataDirectory } =
  await import('./browser-extension-profile-data-directory')

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
      url: `chrome-extension://${ID}/manifest.json`,
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

    const sess = fakeSession(false, partition)
    await clearBrowserExtensionSessionData(sess, ID)
    expect(existsSync(folder)).toBe(false)
    expect(mocks.windows).toHaveLength(0)
    expect(sess.clearStorageData).toHaveBeenCalledOnce()
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
    await removeUninstalledBrowserExtensionData(partition, 'default', new Set([OTHER]))
    expect(existsSync(join(settings, ID))).toBe(false)
    expect(existsSync(join(settings, OTHER))).toBe(true)
    expect(existsSync(join(settings, 'notes'))).toBe(true)
    expect(existsSync(join(partition, 'IndexedDB'))).toBe(true)
  })

  it('does nothing for an in-memory session or a partition without the folder', async () => {
    await expect(
      removeUninstalledBrowserExtensionData(null, 'default', new Set())
    ).resolves.toBeUndefined()
    const empty = mkdtempSync(join(tmpdir(), 'orca-extension-data-'))
    await expect(
      removeUninstalledBrowserExtensionData(empty, 'default', new Set())
    ).resolves.toBeUndefined()
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

    await removeUninstalledBrowserExtensionData(null, 'work', new Set([OTHER]))
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
