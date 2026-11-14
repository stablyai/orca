import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  shim: '/* shim v1 */',
  contentScript: '/* content script */',
  io: { inventories: 0, stats: 0, directories: 0, links: 0, copies: 0, reads: 0 }
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return {
    ...fs,
    readdir: (...args: Parameters<typeof fs.readdir>) => {
      mocks.io.inventories++
      return fs.readdir(...args)
    },
    stat: (...args: Parameters<typeof fs.stat>) => {
      mocks.io.stats++
      return fs.stat(...args)
    },
    mkdir: (...args: Parameters<typeof fs.mkdir>) => {
      mocks.io.directories++
      return fs.mkdir(...args)
    },
    link: (...args: Parameters<typeof fs.link>) => {
      mocks.io.links++
      return fs.link(...args)
    },
    cp: (...args: Parameters<typeof fs.cp>) => {
      mocks.io.copies++
      return fs.cp(...args)
    },
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      mocks.io.reads++
      return fs.readFile(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData, hasSingleInstanceLock: () => false, once: vi.fn() }
}))
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
const { ensureHostSessionState } = await import('../api-runtime/browser-extension-contexts')
const { beginBrowserExtensionExecution, retireBrowserExtensionExecution } =
  await import('../api-runtime/browser-extension-execution-authority')

async function prepare(
  source: 'webstore' | 'unpacked',
  path: string,
  refresh = false,
  knownId?: string
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
  const session = {} as Electron.Session
  ensureHostSessionState(session, path)
  const id = knownId ?? (await browserExtensionIdForUnpackedFolder(path))
  const execution = beginBrowserExtensionExecution(session, id, new AbortController().signal)
  return {
    execution,
    prepared: await prepareBrowserExtensionDirectory({ source, path }, execution, { refresh }),
    retire: () => retireBrowserExtensionExecution(session, id)
  }
}

const STORE_KEY = Buffer.from('store public key').toString('base64')

function writeExtension(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'bg.js'), 'self.started = true')
}

const existsIn = (directory: string, file: string) => existsSync(join(directory, file))
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

describe('extension load directories', () => {
  it('keeps generation resources immutable without changing the installed package', async () => {
    const directory = join(mocks.userData, 'browser-extensions', 'store-ext', '1.0')
    writeExtension(directory, {
      manifest_version: 3,
      name: 'Vault',
      version: '1.0',
      key: STORE_KEY,
      background: { service_worker: 'bg.js' },
      web_accessible_resources: [{ resources: ['*'], matches: ['<all_urls>'] }]
    })
    const original = readFileSync(join(directory, 'manifest.json'), 'utf8')
    const first = await prepare('webstore', directory)
    const next = await prepare('webstore', directory)
    expect(first.prepared.directory).not.toBe(next.prepared.directory)
    expect(first.prepared.extensionId).toBe(chromeExtensionIdFromKey(STORE_KEY))
    expect(readFileSync(join(directory, 'manifest.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(first.prepared.directory, 'bg.js'), 'utf8')).toBe(
      'self.started = true'
    )
    const manifest = JSON.parse(
      readFileSync(join(first.prepared.directory, 'manifest.json'), 'utf8')
    )
    const listed: string[] = manifest.web_accessible_resources.flatMap(
      (entry: { resources: string[] }) => entry.resources
    )
    expect(listed).toContain('bg.js')
    expect(listed).not.toContain(first.execution.contentScriptFile)
    expect(listed.some((file) => file.includes('token'))).toBe(false)
    expect(existsIn(next.prepared.directory, first.execution.contentScriptFile)).toBe(false)
    await first.retire()
    expect(existsIn(first.prepared.directory, 'manifest.json')).toBe(false)
    expect(existsIn(next.prepared.directory, 'bg.js')).toBe(true)
    await next.retire()
  })

  it('shares a pinned unpacked revision until explicit reload and never edits the source', async () => {
    const source = join(mocks.userData, 'dev', 'my-extension')
    writeExtension(source, {
      manifest_version: 3,
      name: 'Dev',
      version: '0.1',
      background: { service_worker: 'bg.js', type: 'module' }
    })
    const before = readdirSync(source).sort()
    const first = await prepare('unpacked', source)
    writeFileSync(join(source, 'bg.js'), 'self.started = "edited"')
    const cached = await prepare('unpacked', source)
    expect(readFileSync(join(cached.prepared.directory, 'bg.js'), 'utf8')).toBe(
      'self.started = true'
    )
    const refreshed = await prepare('unpacked', source, true)
    expect(readFileSync(join(refreshed.prepared.directory, 'bg.js'), 'utf8')).toBe(
      'self.started = "edited"'
    )
    expect(readFileSync(join(first.prepared.directory, 'bg.js'), 'utf8')).toBe(
      'self.started = true'
    )
    expect(refreshed.prepared.extensionId).toBe(first.prepared.extensionId)
    expect(readdirSync(source).sort()).toEqual(before)
    expect(readJson(join(source, 'manifest.json'))).not.toHaveProperty('key')
    await Promise.all([first.retire(), cached.retire(), refreshed.retire()])
  })
})

it.each([100, 1000])(
  'reuses immutable preparation for %i ordinary assets with bounded alias classification',
  async (count) => {
    const { getBrowserExtensionInstallStore } = await import('./browser-extension-install-store')
    const key = Buffer.from(`owned-${count}`).toString('base64')
    const id = chromeExtensionIdFromKey(key)
    const store = getBrowserExtensionInstallStore()
    const directory = store.installDirectory(id, '1.0')
    writeExtension(directory, {
      manifest_version: 3,
      name: 'Owned',
      version: '1.0',
      key,
      web_accessible_resources: [
        { resources: ['*', 'assets/*'], matches: ['<all_urls>'] },
        { resources: ['assets/*', 'manifest.json'], matches: ['<all_urls>'] }
      ]
    })
    mkdirSync(join(directory, 'assets'))
    for (let index = 0; index < count; index++) {
      writeFileSync(join(directory, 'assets', `${index}.txt`), 'immutable bytes')
    }
    store.save({
      id,
      name: 'Owned',
      version: '1.0',
      path: directory,
      source: 'webstore',
      iconPath: null,
      permissions: [],
      hostPermissions: [],
      optionsPage: null
    })
    const first = await prepare('webstore', directory, false, id)
    expect(statSync(join(first.prepared.directory, 'assets', '0.txt')).ino).toBe(
      statSync(join(directory, 'assets', '0.txt')).ino
    )
    Object.assign(mocks.io, {
      inventories: 0,
      stats: 0,
      directories: 0,
      links: 0,
      copies: 0,
      reads: 0
    })
    const second = await prepare('webstore', directory, false, id)
    expect(mocks.io.inventories).toBe(0)
    expect(mocks.io.directories).toBe(2)
    expect(mocks.io.reads).toBe(0)
    expect(mocks.io.links).toBe(count + 1)
    expect(mocks.io.copies).toBe(1)
    expect(mocks.io.stats).toBeLessThanOrEqual(count + 5)
    expect(readFileSync(join(second.prepared.directory, 'assets', '0.txt'), 'utf8')).toBe(
      'immutable bytes'
    )
    await Promise.all([first.retire(), second.retire()])
  }
)

it('keeps case-alias manifest assets independent on case-insensitive filesystems', async (context) => {
  const { getBrowserExtensionInstallStore } = await import('./browser-extension-install-store')
  const key = Buffer.from('case-alias').toString('base64')
  const id = chromeExtensionIdFromKey(key)
  const store = getBrowserExtensionInstallStore()
  const directory = store.installDirectory(id, '1.0')
  mkdirSync(directory, { recursive: true })
  const original = JSON.stringify({
    manifest_version: 3,
    name: 'Case alias',
    version: '1.0',
    key,
    background: { service_worker: 'bg.js' }
  })
  writeFileSync(join(directory, 'MANIFEST.JSON'), original)
  writeFileSync(join(directory, 'bg.js'), 'self.started = true')
  if (!existsSync(join(directory, 'manifest.json'))) {
    context.skip()
  }
  store.save({
    id,
    name: 'Case alias',
    version: '1.0',
    path: directory,
    source: 'webstore',
    iconPath: null,
    permissions: [],
    hostPermissions: [],
    optionsPage: null
  })
  const first = await prepare('webstore', directory, false, id)
  const before = readFileSync(join(first.prepared.directory, 'manifest.json'), 'utf8')
  const second = await prepare('webstore', directory, false, id)
  expect(readFileSync(join(directory, 'MANIFEST.JSON'), 'utf8')).toBe(original)
  expect(readFileSync(join(first.prepared.directory, 'manifest.json'), 'utf8')).toBe(before)
  expect(statSync(join(first.prepared.directory, 'manifest.json')).ino).not.toBe(
    statSync(join(second.prepared.directory, 'manifest.json')).ino
  )
  await Promise.all([first.retire(), second.retire()])
})
