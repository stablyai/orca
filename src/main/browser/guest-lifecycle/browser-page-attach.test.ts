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
type Outcome = 'loads' | 'fails' | 'downloads'

function openTab(pageId: string, url: string, racesExtensions = false, outcome: Outcome = 'loads') {
  const loads: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach reads only the members faked here.
  const guest = Object.assign(new EventEmitter(), {
    id: Math.random(),
    hostWebContents: { id: RENDERER_ID },
    getType: () => 'webview',
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    loadURL: (loaded: string) => {
      loads.push(loaded)
      // Like Electron: the load events fire, then loadURL settles the same way.
      return new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          if (outcome === 'fails') {
            guest.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', loaded, true)
            reject(new Error('ERR_CONNECTION_REFUSED'))
          } else if (outcome === 'downloads') {
            guest.emit('did-stop-loading')
            reject(Object.assign(new Error('ERR_ABORTED'), { errno: -3 }))
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
    vi.useFakeTimers()
    try {
      const url = 'http://localhost:9/'
      openTab('page-failed', url, false, 'fails')
      await vi.advanceTimersByTimeAsync(10)

      await expect(claimBrowserPageFirstLoad('page-failed', url)?.load).rejects.toThrow(
        'ERR_CONNECTION_REFUSED'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a first load that became a download without waiting out the timeout', async () => {
    vi.useFakeTimers()
    try {
      const url = 'https://example.com/report.zip'
      openTab('page-download', url, false, 'downloads')
      const claimed = claimBrowserPageFirstLoad('page-download', url)
      await vi.advanceTimersByTimeAsync(10)
      let settled = false
      void claimed?.load.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a load that raced starting extensions to be loaded again', () => {
    const url = 'https://example.com/'
    openTab('page-extensions', url, true)
    expect(claimBrowserPageFirstLoad('page-extensions', url)).toBeNull()
  })
})
