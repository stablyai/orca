import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  claimBrowserPageFirstLoad,
  prepareBrowserPageAttach,
  startBrowserPageAttach
} from './browser-page-memory'

vi.mock('electron', () => ({ app: { on: vi.fn(), off: vi.fn() }, session: {} }))

const RENDERER_ID = 7
const PARTITION = 'persist:orca-browser'

// The renderer opens a created tab at its URL; main's attach makes that first load.
function openTab(pageId: string, url: string, racesExtensions = false, fails = false) {
  const loads: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach reads only the members faked here.
  const guest = Object.assign(new EventEmitter(), {
    id: Math.random(),
    hostWebContents: { id: RENDERER_ID },
    getType: () => 'webview',
    isDestroyed: () => false,
    loadURL: (loaded: string) => {
      loads.push(loaded)
      // Like Electron: the load events fire, then loadURL settles the same way.
      return new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          if (fails) {
            guest.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', loaded, true)
            reject(new Error('ERR_CONNECTION_REFUSED'))
          } else {
            guest.emit('did-finish-load')
            resolve()
          }
        }, 1)
      )
    }
  }) as unknown as Electron.WebContents
  const marker = prepareBrowserPageAttach(pageId, RENDERER_ID, PARTITION, url)
  admitBrowserPageAttach(marker, RENDERER_ID, PARTITION)
  associateBrowserPageAttach(guest)
  startBrowserPageAttach(guest, undefined, racesExtensions)
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

  it('still reports a first load that failed before it was claimed', async () => {
    const url = 'http://localhost:9/'
    openTab('page-failed', url, false, true)
    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(claimBrowserPageFirstLoad('page-failed', url)?.load).rejects.toThrow(
      'ERR_CONNECTION_REFUSED'
    )
  })

  it('leaves a load that raced starting extensions to be loaded again', () => {
    const url = 'https://example.com/'
    openTab('page-extensions', url, true)
    expect(claimBrowserPageFirstLoad('page-extensions', url)).toBeNull()
  })
})
