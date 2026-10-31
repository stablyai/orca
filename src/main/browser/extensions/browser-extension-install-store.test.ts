import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { BrowserExtensionInstallStore } = await import('./browser-extension-install-store')
const { readBrowserExtensionIconDataUrl } = await import('./browser-extension-manifest')

const STORE_ID = 'a'.repeat(32)
const UNPACKED_ID = 'b'.repeat(32)
let root: string

function record(overrides: Partial<InstalledBrowserExtension>): InstalledBrowserExtension {
  return {
    id: STORE_ID,
    name: 'Vault',
    version: '1.2.3',
    path: '',
    source: 'webstore',
    iconPath: null,
    permissions: [],
    hostPermissions: [],
    optionsPage: null,
    ...overrides
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-browser-extensions-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('BrowserExtensionInstallStore', () => {
  it('deletes the folder of a store install but never an unpacked folder', async () => {
    const store = new BrowserExtensionInstallStore(join(root, 'browser-extensions'))
    const storeDir = store.installDirectory(STORE_ID, '1.2.3')
    const unpackedDir = join(root, 'my-extension')
    mkdirSync(storeDir, { recursive: true })
    mkdirSync(unpackedDir, { recursive: true })
    store.save(record({ path: storeDir }))
    store.save(record({ id: UNPACKED_ID, path: unpackedDir, source: 'unpacked' }))

    await store.remove(STORE_ID)
    await store.remove(UNPACKED_ID)

    expect(existsSync(join(root, 'browser-extensions', STORE_ID))).toBe(false)
    expect(existsSync(unpackedDir)).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('persists monotonic install precedence, including legacy records and explicit same-version updates', async () => {
    writeFileSync(
      join(root, 'installed.json'),
      JSON.stringify([record({ id: STORE_ID }), record({ id: UNPACKED_ID })])
    )
    const store = new BrowserExtensionInstallStore(root)
    const older = store.get(STORE_ID)?.installTime
    const newer = store.get(UNPACKED_ID)?.installTime
    expect(older).toBeLessThan(newer ?? 0)
    expect(new BrowserExtensionInstallStore(root).get(STORE_ID)?.installTime).toBe(older)
    store.save(record({ id: STORE_ID }))
    expect(store.get(STORE_ID)?.installTime).toBe(older)
    store.save(record({ id: STORE_ID }), true)
    expect(store.get(STORE_ID)?.installTime).toBeGreaterThan(newer ?? 0)
    const updated = store.get(STORE_ID)?.installTime
    await store.remove(STORE_ID)
    store.save(record({ id: STORE_ID }))
    expect(store.get(STORE_ID)?.installTime).toBeGreaterThanOrEqual(updated ?? 0)
  })

  it('refuses install directories that could escape the root', () => {
    const store = new BrowserExtensionInstallStore(root)
    expect(() => store.installDirectory('../evil', '1.0')).toThrow()
    expect(() => store.installDirectory(STORE_ID, '../../1.0')).toThrow()
  })
})

describe('readBrowserExtensionManifest', () => {
  it('reads icons only from inside the extension folder', async () => {
    writeFileSync(join(root, 'icon.png'), Buffer.from([1, 2, 3]))
    await expect(readBrowserExtensionIconDataUrl(root, 'icon.png')).resolves.toBe(
      'data:image/png;base64,AQID'
    )
    await expect(
      readBrowserExtensionIconDataUrl(join(root, 'sub'), '../icon.png')
    ).resolves.toBeNull()
  })
})
