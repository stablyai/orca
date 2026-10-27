import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), on: vi.fn() } }))

const { BrowserExtensionProfileStateStore, emptyBrowserExtensionProfileState } =
  await import('./browser-extension-profile-state-store')

const EXTENSION = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-extension-state-'))
})
afterEach(() => {
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

describe('BrowserExtensionProfileStateStore', () => {
  it('keeps each profile and extension apart and survives a restart', () => {
    const store = new BrowserExtensionProfileStateStore(root)
    store.update('default', EXTENSION, (state) => ({
      ...state,
      grantedPermissions: ['privacy'],
      contextMenus: [menu],
      contentScripts: [{ id: 'cs', matches: ['<all_urls>'], js: ['cs.js'] }],
      lastLoaded: { extensionVersion: '1.2', chromiumVersion: '140.0' }
    }))
    store.update('work', EXTENSION, (state) => ({ ...state, grantedOrigins: ['https://a.test/*'] }))
    store.flush()

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

  it('forgets a removed extension everywhere and a deleted profile entirely', () => {
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
    store.flush()

    const reopened = new BrowserExtensionProfileStateStore(root)
    expect(reopened.read('default', EXTENSION)).toEqual(emptyBrowserExtensionProfileState())
    expect(reopened.read('default', OTHER).contextMenus).toEqual([menu])
    expect(reopened.read('work', OTHER).contextMenus).toEqual([])
  })
})
