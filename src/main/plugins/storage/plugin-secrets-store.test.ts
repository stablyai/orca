import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storageMocks = vi.hoisted(() => ({
  available: true,
  backend: 'gnome_libsecret',
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => {
    const text = value.toString('utf8')
    if (!text.startsWith('encrypted:')) {
      throw new Error('wrong key or corrupt ciphertext')
    }
    return text.slice('encrypted:'.length)
  })
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => storageMocks.available,
    encryptString: storageMocks.encryptString,
    decryptString: storageMocks.decryptString,
    getSelectedStorageBackend: () => storageMocks.backend
  }
}))

import { PLUGIN_STORAGE_TOTAL_MAX_BYTES } from '../../../shared/plugins/workers/plugin-host-api-storage-schemas'
import { PluginSecretsStore } from './plugin-secrets-store'
import { PluginKvStore } from './plugin-storage-store'

const roots: string[] = []
const originalPlatform = process.platform

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-secrets-'))
  roots.push(root)
  return root
}

beforeEach(() => {
  storageMocks.available = true
  storageMocks.backend = 'gnome_libsecret'
  storageMocks.encryptString.mockImplementation((value) =>
    Buffer.from(`encrypted:${value}`, 'utf8')
  )
  storageMocks.decryptString.mockImplementation((value) => {
    const text = value.toString('utf8')
    if (!text.startsWith('encrypted:')) {
      throw new Error('wrong key or corrupt ciphertext')
    }
    return text.slice('encrypted:'.length)
  })
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginSecretsStore', () => {
  it('fails closed without OS encryption and writes no plaintext file', async () => {
    const root = await tempRoot()
    storageMocks.available = false
    const store = new PluginSecretsStore(root, 'acme.demo')

    expect(store.set('token', 'plaintext')).toMatchObject({ ok: false })
    expect(store.get('token')).toMatchObject({ ok: true, value: null })
    await expect(readFile(join(root, 'acme.demo', 'secrets.json.enc'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('refuses to overwrite an oversized vault instead of treating it as empty', async () => {
    const root = await tempRoot()
    const vaultDir = join(root, 'acme.demo')
    const vaultPath = join(vaultDir, 'secrets.json.enc')
    await mkdir(vaultDir, { recursive: true })
    const original = Buffer.alloc(PLUGIN_STORAGE_TOTAL_MAX_BYTES + 1, 'x')
    await writeFile(vaultPath, original)
    const store = new PluginSecretsStore(root, 'acme.demo')

    expect(store.set('token', 'replacement')).toEqual({
      ok: false,
      error: 'secret vault exists but could not be read; refusing to overwrite it'
    })
    expect(store.get('token')).toEqual({
      ok: false,
      error: 'secret vault exists but could not be read; refusing to overwrite it'
    })
    expect((await readFile(vaultPath)).equals(original)).toBe(true)
  })
})

describe('PluginKvStore', () => {
  it('refuses to overwrite an oversized store instead of treating it as empty', async () => {
    const root = await tempRoot()
    const storeDir = join(root, 'acme.demo')
    const storePath = join(storeDir, 'storage.json')
    await mkdir(storeDir, { recursive: true })
    const original = Buffer.alloc(PLUGIN_STORAGE_TOTAL_MAX_BYTES + 1, 'x')
    await writeFile(storePath, original)
    const store = new PluginKvStore(root, 'acme.demo', 'storage.json')

    expect(store.set('token', 'replacement')).toEqual({
      ok: false,
      error: 'storage file exists but could not be read; refusing to overwrite it'
    })
    store.delete('token')
    expect((await readFile(storePath)).equals(original)).toBe(true)
  })
})
