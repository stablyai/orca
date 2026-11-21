import { mkdtempSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A disk whose renames wait for the test, or fail once when asked.
const disk = vi.hoisted(() => {
  let held = false
  const waiting: (() => void)[] = []
  return {
    renames: 0,
    failNext: false,
    hold(): void {
      held = true
    },
    release(): void {
      held = false
      waiting.splice(0).forEach((resolve) => resolve())
    },
    wait: (): Promise<void> =>
      held ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve()
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      disk.renames += 1
      await disk.wait()
      if (disk.failNext) {
        disk.failNext = false
        throw new Error('rename failed')
      }
      return actual.rename(...args)
    }
  }
})

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), on: vi.fn() } }))

const { BrowserExtensionProfileStateStore, emptyBrowserExtensionProfileState } =
  await import('./browser-extension-profile-state-store')

const EXTENSION = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
let root: string

beforeEach(() => {
  disk.renames = 0
  disk.failNext = false
  root = mkdtempSync(join(tmpdir(), 'orca-extension-state-'))
})
afterEach(() => {
  disk.release()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const menu = {
  id: 'fill',
  type: 'normal' as const,
  title: 'Fill',
  contexts: ['editable'],
  enabled: true,
  visible: true
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('BrowserExtensionProfileStateStore', () => {
  it('serves changes while a rename is stuck and saves the newest state after it', async () => {
    const store = new BrowserExtensionProfileStateStore(root)
    disk.hold()
    store.update('default', EXTENSION, (state) => ({ ...state, removalGeneration: 1 }))
    store.saveNow()
    while (disk.renames === 0) {
      await nextTurn()
    }
    store.update('default', EXTENSION, (state) => ({ ...state, removalGeneration: 2 }))
    store.saveNow()
    await nextTurn()
    expect(store.read('default', EXTENSION).removalGeneration).toBe(2)
    expect(disk.renames).toBe(1)

    disk.release()
    await store.close()
    expect(disk.renames).toBe(2)
    expect(new BrowserExtensionProfileStateStore(root).read('default', EXTENSION)).toMatchObject({
      removalGeneration: 2
    })
  })

  it('reports a failed save, retries it at quit and writes nothing more after close', async () => {
    const store = new BrowserExtensionProfileStateStore(root)
    disk.failNext = true
    store.update('default', EXTENSION, (state) => ({ ...state, removalGeneration: 3 }))
    await expect(store.flush()).rejects.toThrow('Could not save extension state')
    await store.close()
    expect(disk.renames).toBe(2)
    expect(new BrowserExtensionProfileStateStore(root).read('default', EXTENSION)).toMatchObject({
      removalGeneration: 3
    })

    store.update('default', EXTENSION, (state) => ({ ...state, removalGeneration: 3 }))
    store.forgetProfile('missing')
    store.update('default', EXTENSION, (state) => ({ ...state, removalGeneration: 4 }))
    await expect(store.flush()).rejects.toThrow('closed for quit')
    await store.close()
    expect(disk.renames).toBe(2)
  })

  it('keeps each profile and extension apart and survives a restart', async () => {
    const store = new BrowserExtensionProfileStateStore(root)
    store.update('default', EXTENSION, (state) => ({
      ...state,
      grantedPermissions: ['privacy'],
      contextMenus: [menu],
      contentScripts: [{ id: 'cs', matches: ['<all_urls>'], js: ['cs.js'] }],
      lastLoaded: { extensionVersion: '1.2', chromiumVersion: '140.0' }
    }))
    store.update('work', EXTENSION, (state) => ({ ...state, grantedOrigins: ['https://a.test/*'] }))
    await store.close()

    const reopened = new BrowserExtensionProfileStateStore(root)
    expect(reopened.read('default', EXTENSION)).toMatchObject({
      grantedPermissions: ['privacy'],
      grantedOrigins: [],
      contextMenus: [menu],
      contentScripts: [{ id: 'cs', matches: ['<all_urls>'], js: ['cs.js'] }],
      lastLoaded: { extensionVersion: '1.2', chromiumVersion: '140.0' }
    })
    expect(reopened.read('work', EXTENSION).lastLoaded).toBeUndefined()
    expect(reopened.read('work', EXTENSION).grantedOrigins).toEqual(['https://a.test/*'])
    expect(reopened.read('default', OTHER).contextMenus).toEqual([])
  })

  it('forgets a removed extension everywhere and a deleted profile entirely', async () => {
    const store = new BrowserExtensionProfileStateStore(root)
    for (const profile of ['default', 'work']) {
      store.update(profile, EXTENSION, (state) => ({
        ...state,
        contextMenus: [menu],
        lastLoaded: { extensionVersion: '1.2', chromiumVersion: '140.0' }
      }))
      store.update(profile, OTHER, (state) => ({ ...state, contextMenus: [menu] }))
    }
    store.forgetExtension(EXTENSION)
    store.forgetProfile('work')
    await store.close()

    const reopened = new BrowserExtensionProfileStateStore(root)
    expect(reopened.read('default', EXTENSION)).toEqual(emptyBrowserExtensionProfileState())
    expect(reopened.read('default', OTHER).contextMenus).toEqual([menu])
    expect(reopened.read('work', OTHER).contextMenus).toEqual([])
  })
})
