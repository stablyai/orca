import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({
  userData: '',
  shim: '/* shim v1 */',
  contentScript: '/* content script */'
}))

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
vi.mock('../api-runtime/browser-extension-worker-shim-source', () => ({
  readBrowserExtensionWorkerShim: () => mocks.shim,
  readBrowserExtensionContentScript: () => mocks.contentScript
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-load-'))

const {
  browserExtensionIdForUnpackedFolder,
  chromeExtensionIdFromKey,
  prepareBrowserExtensionDirectory
} = await import('./browser-extension-load-directory')
const { getBrowserExtensionWorkerToken } =
  await import('../api-runtime/browser-extension-worker-api-host')

const STORE_KEY = Buffer.from('store public key').toString('base64')

function writeExtension(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'bg.js'), 'self.started = true')
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

describe('extension load directories', () => {
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

  it('never lists the worker token as web-accessible, in any spelling', async () => {
    const directory = join(mocks.userData, 'browser-extensions', 'store-war', '1.0')
    const resources = ['ORCA-EXTENSION-API-TOKEN.JSON', 'orca-extension-api-token.json', '*']
    writeExtension(directory, {
      manifest_version: 3,
      name: 'Vault',
      version: '1.0',
      key: STORE_KEY,
      background: { service_worker: 'bg.js' },
      web_accessible_resources: [{ resources, matches: ['<all_urls>'] }]
    })
    await prepareBrowserExtensionDirectory({ source: 'webstore', path: directory })
    const token = statSync(join(directory, 'orca-extension-api-token.json'))
    const listed = z
      .object({ web_accessible_resources: z.tuple([z.object({ resources: z.array(z.string()) })]) })
      .parse(readJson(join(directory, 'manifest.json'))).web_accessible_resources[0].resources
    expect(listed).toContain('bg.js')
    for (const resource of listed) {
      const path = join(directory, resource)
      expect(existsSync(path) && statSync(path).ino === token.ino, resource).toBe(false)
    }
  })
})
