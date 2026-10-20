import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  shim: '/* shim v1 */',
  contentScript: '/* content script */'
}))

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
vi.mock('./browser-extension-worker-shim-source', () => ({
  readBrowserExtensionWorkerShim: () => mocks.shim,
  readBrowserExtensionContentScript: () => mocks.contentScript
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-load-'))

const {
  browserExtensionIdForUnpackedFolder,
  chromeExtensionIdFromKey,
  prepareBrowserExtensionDirectory
} = await import('./browser-extension-load-directory')
const { getBrowserExtensionWorkerToken } = await import('./browser-extension-worker-api-host')

const STORE_KEY = Buffer.from('store public key').toString('base64')

function writeExtension(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'bg.js'), 'self.started = true')
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

describe('extension load directories', () => {
  it('derives ids the way Chromium does from a manifest key', () => {
    // Measured against Electron 43's loadExtension for this key.
    const key = createHash('sha256').update('orca-unpacked:/some/folder').digest('base64')
    expect(chromeExtensionIdFromKey(key)).toBe('facfjoldjaombbaheilnbchaiimdhcbk')
  })

  it('wraps a store install in place and rewrites it when the shim changes', async () => {
    const directory = join(mocks.userData, 'browser-extensions', 'store-ext', '1.0')
    writeExtension(directory, {
      manifest_version: 3,
      name: 'Vault',
      version: '1.0',
      key: STORE_KEY,
      background: { service_worker: 'bg.js' }
    })
    const first = await prepareBrowserExtensionDirectory({ source: 'webstore', path: directory })
    expect(first.directory).toBe(directory)
    expect(first.extensionId).toBe(chromeExtensionIdFromKey(STORE_KEY))
    expect(readJson(join(directory, 'manifest.json'))).toMatchObject({
      key: STORE_KEY,
      background: { service_worker: 'orca-background.js' }
    })
    expect(readJson(join(directory, 'orca-original-manifest.json'))).toMatchObject({
      background: { service_worker: 'bg.js' }
    })
    expect(readFileSync(join(directory, 'bg.js'), 'utf8')).toBe('self.started = true')
    expect(readFileSync(join(directory, 'orca-extension-api.js'), 'utf8')).toBe('/* shim v1 */')
    expect(readJson(join(directory, 'orca-extension-api-token.json'))).toEqual({
      token: getBrowserExtensionWorkerToken(first.extensionId)
    })

    const again = await prepareBrowserExtensionDirectory({ source: 'webstore', path: directory })
    expect(again.workerSignature).toBe(first.workerSignature)

    mocks.shim = '/* shim v2 */'
    const updated = await prepareBrowserExtensionDirectory({ source: 'webstore', path: directory })
    mocks.shim = '/* shim v1 */'
    expect(updated.workerSignature).not.toBe(first.workerSignature)
    expect(readFileSync(join(directory, 'orca-extension-api.js'), 'utf8')).toBe('/* shim v2 */')
  })

  it('loads an unpacked folder from a stable Orca copy and never touches the folder', async () => {
    const source = join(mocks.userData, 'dev', 'my-extension')
    writeExtension(source, {
      manifest_version: 3,
      name: 'Dev',
      version: '0.1',
      background: { service_worker: 'bg.js', type: 'module' }
    })
    const before = readdirSync(source).sort()
    const predicted = await browserExtensionIdForUnpackedFolder(source)
    expect(readdirSync(source).sort()).toEqual(before)
    const first = await prepareBrowserExtensionDirectory({ source: 'unpacked', path: source })
    expect(first.extensionId).toBe(predicted)
    expect(first.directory).not.toBe(source)
    expect(first.workerSignature).toBeNull()
    expect(readdirSync(source).sort()).toEqual(before)
    expect(readJson(join(source, 'manifest.json'))).not.toHaveProperty('key')
    expect(readJson(join(first.directory, 'manifest.json'))).toMatchObject({
      background: { service_worker: 'orca-background.js', type: 'module' }
    })

    // Copied once per run; Reload copies again. The id stays the same either way.
    writeFileSync(join(source, 'bg.js'), 'self.started = "edited"')
    const cached = await prepareBrowserExtensionDirectory({ source: 'unpacked', path: source })
    expect(readFileSync(join(cached.directory, 'bg.js'), 'utf8')).toBe('self.started = true')
    const refreshed = await prepareBrowserExtensionDirectory(
      { source: 'unpacked', path: source },
      { refresh: true }
    )
    expect(readFileSync(join(refreshed.directory, 'bg.js'), 'utf8')).toBe('self.started = "edited"')
    expect(refreshed.extensionId).toBe(first.extensionId)
    expect(refreshed.directory).toBe(first.directory)
  })

  it('runs Orca’s content script first in every isolated-world content script', async () => {
    const source = join(mocks.userData, 'dev', 'content-scripts')
    const content_scripts = [
      { matches: ['https://github.com/*'], css: ['style.css'], js: ['content.js'] },
      { matches: ['https://github.com/*'], css: ['only.css'] },
      { matches: ['https://github.com/*'], js: ['page.js'], world: 'MAIN' }
    ]
    writeExtension(source, {
      manifest_version: 3,
      name: 'Content',
      version: '1',
      background: { service_worker: 'bg.js', type: 'module', scripts: ['bg.js'] },
      content_scripts
    })
    const prepared = await prepareBrowserExtensionDirectory({ source: 'unpacked', path: source })
    expect(readJson(join(prepared.directory, 'manifest.json'))).toMatchObject({
      background: { service_worker: 'orca-background.js', type: 'module' },
      content_scripts: [
        { ...content_scripts[0], js: ['orca-content-script-api.js', 'content.js'] },
        content_scripts[1],
        content_scripts[2]
      ]
    })
    expect(readJson(join(prepared.directory, 'manifest.json'))).not.toHaveProperty(
      'background.scripts'
    )
    expect(readFileSync(join(prepared.directory, 'orca-content-script-api.js'), 'utf8')).toBe(
      '/* content script */'
    )

    // Without a worker the content-script APIs still apply; only the sync relay needs one.
    const workerless = join(mocks.userData, 'dev', 'content-scripts-only')
    writeExtension(workerless, {
      manifest_version: 3,
      name: 'Plain',
      version: '1',
      content_scripts
    })
    const plain = await prepareBrowserExtensionDirectory({ source: 'unpacked', path: workerless })
    expect(readJson(join(plain.directory, 'manifest.json'))).toMatchObject({
      content_scripts: [
        { ...content_scripts[0], js: ['orca-content-script-api.js', 'content.js'] },
        content_scripts[1],
        content_scripts[2]
      ]
    })
    expect(existsSync(join(plain.directory, 'orca-content-script-api.js'))).toBe(true)
  })

  it('keeps the id an unpacked folder pins with its own key', async () => {
    const source = join(mocks.userData, 'dev', 'keyed')
    writeExtension(source, { manifest_version: 3, name: 'Keyed', version: '1', key: STORE_KEY })
    expect(await browserExtensionIdForUnpackedFolder(source)).toBe(
      chromeExtensionIdFromKey(STORE_KEY)
    )
    const prepared = await prepareBrowserExtensionDirectory({ source: 'unpacked', path: source })
    expect(prepared.extensionId).toBe(chromeExtensionIdFromKey(STORE_KEY))
    expect(existsSync(join(prepared.directory, 'orca-extension-api.js'))).toBe(false)
  })

  it('refuses Manifest V2', async () => {
    const source = join(mocks.userData, 'dev', 'legacy')
    writeExtension(source, { manifest_version: 2, name: 'Old', version: '1' })
    await expect(
      prepareBrowserExtensionDirectory({ source: 'unpacked', path: source })
    ).rejects.toThrow('Manifest V3')
  })
})
