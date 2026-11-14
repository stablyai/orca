import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => {
  const state: {
    heldMkdir: Promise<void> | null
    failingRemovals: number
    beforeRemove: ((path: string) => Promise<void>) | null
  } = {
    heldMkdir: null,
    failingRemovals: 0,
    beforeRemove: null
  }
  return state
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      await io.heldMkdir
      return fs.mkdir(...args)
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await io.beforeRemove?.(String(args[0]))
      if (io.failingRemovals > 0) {
        io.failingRemovals--
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      }
      return fs.rm(...args)
    }
  }
})
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), on: vi.fn() } }))

const { BrowserExtensionProfileDocumentStore } =
  await import('./browser-extension-profile-document-store')

const EXTENSION = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-extension-sync-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  io.heldMkdir = null
  io.failingRemovals = 0
  io.beforeRemove = null
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('BrowserExtensionProfileDocumentStore', () => {
  it('retries acknowledged writes after a failed save', async () => {
    const store = new BrowserExtensionProfileDocumentStore(root)
    store.write('default', EXTENSION, { token: 'saved after recovery' })
    writeFileSync(join(root, 'sync-storage'), 'blocks the storage directory')
    await store.flush()
    rmSync(join(root, 'sync-storage'))

    await store.flush()
    expect(new BrowserExtensionProfileDocumentStore(root).read('default', EXTENSION)).toEqual({
      token: 'saved after recovery'
    })
  })

  it('forgets a removed extension in every profile and a deleted profile entirely', async () => {
    const store = new BrowserExtensionProfileDocumentStore(root)
    for (const profile of ['default', 'work']) {
      store.write(profile, EXTENSION, { kept: profile })
      store.write(profile, OTHER, { kept: profile })
    }
    await store.flush()
    writeFileSync(join(root, 'sync-storage', '.DS_Store'), 'Finder metadata')
    // A pending write must not bring a forgotten extension back.
    store.write('default', EXTENSION, { pending: true })
    await Promise.all([store.forgetExtension(EXTENSION), store.forgetProfile('work')])
    await store.flush()
    expect(store.read('default', EXTENSION)).toEqual({})

    const reopened = new BrowserExtensionProfileDocumentStore(root)
    expect(reopened.read('default', EXTENSION)).toEqual({})
    expect(reopened.read('default', OTHER)).toEqual({ kept: 'default' })
    expect(reopened.read('work', OTHER)).toEqual({})
  })

  it('keeps a reinstalled extension’s new items when it was forgotten during an older save', async () => {
    const store = new BrowserExtensionProfileDocumentStore(root)
    let release: () => void = () => {}
    io.heldMkdir = new Promise((resolve) => (release = resolve))
    store.write('default', EXTENSION, { token: 'old' })
    const saving = store.flush()
    // The save waits on its own I/O instead of writing on the caller's turn.
    expect(existsSync(join(root, 'sync-storage', 'default', `${EXTENSION}.json`))).toBe(false)

    const forgotten = store.forgetProfileExtension('default', EXTENSION)
    expect(store.read('default', EXTENSION)).toEqual({})
    store.write('default', EXTENSION, { token: 'new' })
    release()
    await Promise.all([saving, forgotten])
    await store.flush()

    expect(new BrowserExtensionProfileDocumentStore(root).read('default', EXTENSION)).toEqual({
      token: 'new'
    })
  })

  it('saves a write made after a forget only once the forget’s delete succeeds', async () => {
    const store = new BrowserExtensionProfileDocumentStore(root)
    store.write('default', EXTENSION, { token: 'old' })
    await store.flush()
    io.failingRemovals = 2

    await expect(store.forgetProfileExtension('default', EXTENSION)).rejects.toThrow(
      'resource busy'
    )
    store.write('default', EXTENSION, { token: 'new' })
    await store.flush()
    await store.flush()

    expect(new BrowserExtensionProfileDocumentStore(root).read('default', EXTENSION)).toEqual({
      token: 'new'
    })
  })

  it('finishes every delete of a failed forget before a later write can land', async () => {
    const seeded = new BrowserExtensionProfileDocumentStore(root)
    seeded.write('first', EXTENSION, { token: 'old' })
    seeded.write('second', EXTENSION, { token: 'old' })
    await seeded.flush()
    let release: () => void = () => {}
    let secondStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => (secondStarted = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    io.beforeRemove = async (path) => {
      if (path.includes(`${sep}first${sep}`)) {
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      }
      if (path.includes(`${sep}second${sep}`)) {
        secondStarted()
        await held
      }
    }

    const store = new BrowserExtensionProfileDocumentStore(root)
    let settled = false
    const forgotten = store.forgetExtension(EXTENSION).finally(() => (settled = true))
    // Never read before, yet it must not load the file its pending delete removes.
    expect(store.read('second', EXTENSION)).toEqual({})
    await started
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    release()
    await expect(forgotten).rejects.toThrow('resource busy')
    io.beforeRemove = null
    store.write('second', EXTENSION, { token: 'new' })
    await store.flush()

    expect(new BrowserExtensionProfileDocumentStore(root).read('second', EXTENSION)).toEqual({
      token: 'new'
    })
  })

  it('saves writes made before close, not after', async () => {
    const store = new BrowserExtensionProfileDocumentStore(root)
    let release: () => void = () => {}
    io.heldMkdir = new Promise((resolve) => (release = resolve))
    store.write('default', EXTENSION, { token: 'before quit' })
    const closing = store.close()
    store.write('default', EXTENSION, { token: 'after quit' })
    await expect(store.forgetProfileExtension('default', EXTENSION)).rejects.toThrow()
    release()
    await closing

    expect(new BrowserExtensionProfileDocumentStore(root).read('default', EXTENSION)).toEqual({
      token: 'before quit'
    })
  })
})
