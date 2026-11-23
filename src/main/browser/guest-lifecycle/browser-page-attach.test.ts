import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  claimBrowserPageFirstLoad,
  prepareBrowserPageAttach,
  startBrowserPageAttach
} from './browser-page-memory'

const extensionsStarting = vi.hoisted(() => ({ value: false }))
vi.mock('electron', () => ({ app: { on: vi.fn(), off: vi.fn() }, session: {} }))
vi.mock('../extensions/profile-sessions/browser-extension-page-start', () => ({
  whenBrowserExtensionsReadyForPage: () => (extensionsStarting.value ? Promise.resolve() : null)
}))

const RENDERER_ID = 7
const PARTITION = 'persist:orca-browser'

// The renderer opens a created tab at its URL; main's attach makes that first load.
function openTab(pageId: string, url: string) {
  const loads: string[] = []
  const guest = Object.assign(new EventEmitter(), {
    id: Math.random(),
    hostWebContents: { id: RENDERER_ID },
    getType: () => 'webview',
    isDestroyed: () => false,
    loadURL: (loaded: string) => {
      loads.push(loaded)
      setTimeout(() => guest.emit('did-finish-load'), 1)
      return Promise.resolve()
    }
  }) as unknown as Electron.WebContents
  const marker = prepareBrowserPageAttach(pageId, RENDERER_ID, PARTITION, url)
  admitBrowserPageAttach(marker, RENDERER_ID, PARTITION)
  associateBrowserPageAttach(guest)
  startBrowserPageAttach(guest)
  return { guest, loads }
}

describe('claimBrowserPageFirstLoad', () => {
  it('hands a created tab its own first load once, so its URL is requested once', async () => {
    const url = 'https://example.com/callback?code=1'
    const { guest, loads } = openTab('page-once', url)

    const claimed = claimBrowserPageFirstLoad('page-once', url)
    expect(claimed?.guest).toBe(guest)
    await claimed?.load
    expect(claimBrowserPageFirstLoad('page-once', url)).toBeNull()
    expect(loads).toEqual([url])
  })

  it('leaves a load that raced starting extensions to be loaded again', () => {
    extensionsStarting.value = true
    try {
      const url = 'https://example.com/'
      openTab('page-extensions', url)
      expect(claimBrowserPageFirstLoad('page-extensions', url)).toBeNull()
    } finally {
      extensionsStarting.value = false
    }
  })
})
