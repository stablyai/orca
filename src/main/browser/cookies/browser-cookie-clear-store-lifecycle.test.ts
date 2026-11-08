import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

const electron = vi.hoisted(() => {
  const windows: BrowserWindow[] = []
  const getAllWebContents = vi.fn(() => [])

  class BrowserWindow {
    destroy = vi.fn()
    resolveLoad!: () => void
    webContents = {
      debugger: {
        sendCommand: vi.fn(
          async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({
            cookies: []
          })
        )
      },
      isDestroyed: vi.fn(() => false)
    }

    constructor() {
      windows.push(this)
    }

    loadURL() {
      return new Promise<void>((resolve) => {
        this.resolveLoad = resolve
      })
    }
  }

  return { BrowserWindow, getAllWebContents, windows }
})

const lease = vi.hoisted(() => ({ release: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow,
  webContents: { getAllWebContents: electron.getAllWebContents }
}))
vi.mock('../cdp/debugger/electron-debugger-lease', () => ({
  acquireElectronDebugger: vi.fn(() => lease)
}))

import { withCookieMutationLock } from './browser-cookie-import-clear'
import { writeImportedCookies, type SourceCookieToWrite } from './browser-cookie-import-write'
import { openCookieClearStore } from './browser-cookie-clear-store'

function targetSession(): Session {
  return { cookies: { get: vi.fn(), remove: vi.fn() } } as unknown as Session
}

describe('cookie clear debugger lifecycle', () => {
  beforeEach(() => {
    electron.windows.length = 0
    electron.getAllWebContents.mockReturnValue([])
    lease.release.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it('retires a hung command before releasing the lock, fails remaining rows immediately, then admits a second import', async () => {
    const owner = targetSession()
    const row: SourceCookieToWrite = {
      url: 'https://app.example/',
      domain: 'app.example',
      name: 'sid',
      value: 'old',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      expirationDate: undefined,
      partition: { status: 'unpartitioned' }
    }
    const first = withCookieMutationLock(owner, async () => {
      const store = openCookieClearStore(owner)
      try {
        return await writeImportedCookies(store, [row, { ...row, name: 'remaining' }], {
          log: () => {}
        })
      } finally {
        store.dispose()
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    const window = electron.windows[0]
    window.webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    window.resolveLoad()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await first).toMatchObject({ importedCount: 0, writeRejected: 2 })
    expect(window.webContents.debugger.sendCommand).toHaveBeenCalledOnce()
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(lease.release).toHaveBeenCalledOnce()
    const second = withCookieMutationLock(owner, async () => {
      expect(window.destroy).toHaveBeenCalledOnce()
      const store = openCookieClearStore(owner)
      const write = store.writeCookieIdentity({ ...row, value: 'new' })
      electron.windows[1].resolveLoad()
      await write
      store.dispose()
    })
    await second
  })
})
