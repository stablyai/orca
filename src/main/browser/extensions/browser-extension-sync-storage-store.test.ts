import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), on: vi.fn() } }))

const { BrowserExtensionSyncStorageStore } = await import('./browser-extension-sync-storage-store')

const EXTENSION = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-extension-sync-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('BrowserExtensionSyncStorageStore', () => {
  it('keeps each profile and extension apart and survives a restart', () => {
    const store = new BrowserExtensionSyncStorageStore(root)
    store.write('default', EXTENSION, { theme: { dark: true }, list: [1, 'two'] })
    store.write('work', EXTENSION, { theme: 'light' })
    store.flush()

    const reopened = new BrowserExtensionSyncStorageStore(root)
    expect(reopened.read('default', EXTENSION)).toEqual({ theme: { dark: true }, list: [1, 'two'] })
    expect(reopened.read('work', EXTENSION)).toEqual({ theme: 'light' })
    expect(reopened.read('default', OTHER)).toEqual({})
  })

  it('retries acknowledged writes after a failed flush', () => {
    const store = new BrowserExtensionSyncStorageStore(root)
    store.write('default', EXTENSION, { token: 'saved after recovery' })
    writeFileSync(join(root, 'sync-storage'), 'blocks the storage directory')
    expect(() => store.flush()).toThrow()
    rmSync(join(root, 'sync-storage'))

    store.flush()
    expect(new BrowserExtensionSyncStorageStore(root).read('default', EXTENSION)).toEqual({
      token: 'saved after recovery'
    })
  })

  it('forgets a removed extension in every profile and a deleted profile entirely', () => {
    const store = new BrowserExtensionSyncStorageStore(root)
    for (const profile of ['default', 'work']) {
      store.write(profile, EXTENSION, { kept: profile })
      store.write(profile, OTHER, { kept: profile })
    }
    store.flush()
    // A pending write must not bring a forgotten extension back.
    store.write('default', EXTENSION, { pending: true })
    store.forgetExtension(EXTENSION)
    store.forgetProfile('work')
    store.flush()
    expect(store.read('default', EXTENSION)).toEqual({})

    const reopened = new BrowserExtensionSyncStorageStore(root)
    expect(reopened.read('default', EXTENSION)).toEqual({})
    expect(reopened.read('default', OTHER)).toEqual({ kept: 'default' })
    expect(reopened.read('work', OTHER)).toEqual({})
  })
})
