import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WindowRecord = { options: unknown; url: string; script: string; destroyed: boolean }

const mocks = vi.hoisted(() => {
  const windows: WindowRecord[] = []
  return { windows }
})

vi.mock('electron', () => ({
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

const { clearBrowserExtensionSessionData, removeOrphanedBrowserExtensionStorage } =
  await import('./browser-extension-data-removal')

const ID = 'nngceckbapebfimnlniiiahkandclblb'
const OTHER = 'ddkjiahejlhfcafbddmgiahcphecmpfh'

function fakeSession(loaded: boolean): Electron.Session {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test calls only these members.
  return {
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

  it('clears only origin data in a profile where the extension is not loaded', async () => {
    const sess = fakeSession(false)
    await clearBrowserExtensionSessionData(sess, ID)
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

describe('removeOrphanedBrowserExtensionStorage', () => {
  it('deletes only the storage folders of extensions that are no longer installed', async () => {
    const partition = mkdtempSync(join(tmpdir(), 'orca-extension-data-'))
    const settings = join(partition, 'Local Extension Settings')
    for (const folder of [join(settings, ID), join(settings, OTHER), join(settings, 'notes')]) {
      mkdirSync(folder, { recursive: true })
    }
    mkdirSync(join(partition, 'IndexedDB'))
    await removeOrphanedBrowserExtensionStorage(partition, new Set([OTHER]))
    expect(existsSync(join(settings, ID))).toBe(false)
    expect(existsSync(join(settings, OTHER))).toBe(true)
    expect(existsSync(join(settings, 'notes'))).toBe(true)
    expect(existsSync(join(partition, 'IndexedDB'))).toBe(true)
  })

  it('does nothing for an in-memory session or a partition without the folder', async () => {
    await expect(removeOrphanedBrowserExtensionStorage(null, new Set())).resolves.toBeUndefined()
    const empty = mkdtempSync(join(tmpdir(), 'orca-extension-data-'))
    await expect(removeOrphanedBrowserExtensionStorage(empty, new Set())).resolves.toBeUndefined()
  })
})
