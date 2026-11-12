import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), on: vi.fn() } }))

const { BrowserExtensionProfileDocumentStore } =
  await import('./browser-extension-profile-document-store')

const EXTENSION = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-extension-sync-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('BrowserExtensionProfileDocumentStore', () => {
  it('retries acknowledged writes after a failed flush', () => {
    const store = new BrowserExtensionProfileDocumentStore(root)
    store.write('default', EXTENSION, { token: 'saved after recovery' })
    writeFileSync(join(root, 'sync-storage'), 'blocks the storage directory')
    expect(() => store.flush()).toThrow()
    rmSync(join(root, 'sync-storage'))

    store.flush()
    expect(new BrowserExtensionProfileDocumentStore(root).read('default', EXTENSION)).toEqual({
      token: 'saved after recovery'
    })
  })

  it('forgets a removed extension in every profile and a deleted profile entirely', () => {
    const store = new BrowserExtensionProfileDocumentStore(root)
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

    const reopened = new BrowserExtensionProfileDocumentStore(root)
    expect(reopened.read('default', EXTENSION)).toEqual({})
    expect(reopened.read('default', OTHER)).toEqual({ kept: 'default' })
    expect(reopened.read('work', OTHER)).toEqual({})
  })
})
