import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { BrowserExtensionInstallStore } = await import('./browser-extension-install-store')
const { readBrowserExtensionIconDataUrl, readBrowserExtensionManifest } =
  await import('./browser-extension-manifest')

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
  it('persists the installed list across instances', () => {
    const store = new BrowserExtensionInstallStore(join(root, 'browser-extensions'))
    store.save(record({ path: store.installDirectory(STORE_ID, '1.2.3') }))
    const reopened = new BrowserExtensionInstallStore(join(root, 'browser-extensions'))
    expect(reopened.get(STORE_ID)?.path).toBe(join(root, 'browser-extensions', STORE_ID, '1.2.3'))
  })

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

  it('refuses install directories that could escape the root', () => {
    const store = new BrowserExtensionInstallStore(root)
    expect(() => store.installDirectory('../evil', '1.0')).toThrow()
    expect(() => store.installDirectory(STORE_ID, '../../1.0')).toThrow()
  })
})

describe('readBrowserExtensionManifest', () => {
  it('localizes the name, splits host permissions and finds the options page and icon', async () => {
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: '__MSG_extName__',
        version: '2024.1.0',
        default_locale: 'en',
        permissions: ['tabs', 'webNavigation', '<all_urls>'],
        host_permissions: ['https://*.example.com/*'],
        options_ui: { page: 'options.html' },
        icons: { '16': 'icon16.png', '128': 'icon128.png', '256': 'icon256.png' }
      })
    )
    mkdirSync(join(root, '_locales', 'en'), { recursive: true })
    writeFileSync(
      join(root, '_locales', 'en', 'messages.json'),
      JSON.stringify({ ExtName: { message: 'Vault Manager' } })
    )

    await expect(readBrowserExtensionManifest(root)).resolves.toEqual({
      name: 'Vault Manager',
      version: '2024.1.0',
      iconPath: 'icon128.png',
      permissions: ['tabs', 'webNavigation'],
      hostPermissions: ['<all_urls>', 'https://*.example.com/*'],
      optionsPage: 'options.html'
    })
  })

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
