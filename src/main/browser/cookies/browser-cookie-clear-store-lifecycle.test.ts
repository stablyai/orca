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
vi.mock('../electron-debugger-lease', () => ({
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

  it('memoizes a pending hidden-window attachment across concurrent callers', async () => {
    const store = openCookieClearStore(targetSession())
    const snapshot = store.snapshotClearIdentities([])
    const restore = store.restoreClearIdentities([])

    expect(electron.windows).toHaveLength(1)
    electron.windows[0].resolveLoad()
    await Promise.all([snapshot, restore])
    expect(
      electron.windows[0].webContents.debugger.sendCommand.mock.calls.map(([method]) => method)
    ).toEqual(['Network.getAllCookies'])
    store.dispose()
    expect(lease.release).toHaveBeenCalledOnce()
  })

  it('releases an attachment that resolves after disposal', async () => {
    const store = openCookieClearStore(targetSession())
    const snapshot = store.snapshotClearIdentities([])

    store.dispose()
    electron.windows[0].resolveLoad()
    await expect(snapshot).rejects.toThrow()
    expect(lease.release).not.toHaveBeenCalled()
    expect(electron.windows[0].destroy).toHaveBeenCalledOnce()
    await expect(store.restoreClearIdentities([])).rejects.toThrow(/store was disposed/)
    expect(electron.windows).toHaveLength(1)
  })

  it('attempts the whole frozen restore snapshot after one cookie is rejected', async () => {
    const store = openCookieClearStore(targetSession())
    const restore = store.restoreClearIdentities([
      { url: 'https://first.example/', name: 'first', value: 'one', sameSite: 'unspecified' },
      { url: 'https://second.example/', name: 'second', value: 'two', sameSite: 'unspecified' }
    ])
    const sendCommand = electron.windows[0].webContents.debugger.sendCommand
    sendCommand.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true })

    electron.windows[0].resolveLoad()

    await expect(restore).rejects.toThrow(/restore/i)
    expect(sendCommand.mock.calls.map(([, params]) => params?.name)).toEqual(['first', 'second'])
  })
  it('bounds a never-settling attach and disposes a late load without attaching', async () => {
    const store = openCookieClearStore(targetSession())
    const read = expect(store.snapshotClearIdentities([])).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(10_000)
    await read
    expect(electron.windows[0].destroy).toHaveBeenCalledOnce()
    electron.windows[0].resolveLoad()
    await Promise.resolve()
    expect(lease.release).not.toHaveBeenCalled()
    expect(electron.windows[0].webContents.debugger.sendCommand).not.toHaveBeenCalled()
  })

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

  it.each([200, 2000])(
    'uses one target, N commands and N+1 nonoverlapping deadlines for %i rows',
    async (count) => {
      const fakeSetTimeout = globalThis.setTimeout
      let peakTimers = 0
      const deadlines = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
        const timer = fakeSetTimeout(...args)
        peakTimers = Math.max(peakTimers, vi.getTimerCount())
        return timer
      })
      const store = openCookieClearStore(targetSession())
      try {
        const rows: SourceCookieToWrite[] = Array.from({ length: count }, (_, index) => ({
          url: 'https://app.example/',
          domain: 'app.example',
          name: `cookie${index}`,
          value: 'value',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          expirationDate: undefined,
          partition: { status: 'unpartitioned' }
        }))
        const write = writeImportedCookies(store, rows, { log: () => {} })
        const window = electron.windows[0]
        window.webContents.debugger.sendCommand.mockResolvedValue({ success: true })
        window.resolveLoad()
        expect(await write).toMatchObject({ importedCount: count, writeRejected: 0 })
        expect(electron.windows).toHaveLength(1)
        expect(window.webContents.debugger.sendCommand).toHaveBeenCalledTimes(count)
        expect(deadlines).toHaveBeenCalledTimes(count + 1)
        expect(peakTimers).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
        store.dispose()
        expect(window.destroy).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        store.dispose()
        deadlines.mockRestore()
      }
    }
  )

  it('dispatches no more commands or deadlines for 2000 rows after the first command times out', async () => {
    const deadlines = vi.spyOn(globalThis, 'setTimeout')
    const store = openCookieClearStore(targetSession())
    try {
      const rows: SourceCookieToWrite[] = Array.from({ length: 2000 }, (_, index) => ({
        url: 'https://app.example/',
        domain: 'app.example',
        name: `cookie${index}`,
        value: 'value',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: undefined,
        partition: { status: 'unpartitioned' }
      }))
      const write = writeImportedCookies(store, rows, { log: () => {} })
      const window = electron.windows[0]
      window.webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
      window.resolveLoad()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await write).toMatchObject({ importedCount: 0, writeRejected: 2000 })
      expect(electron.windows).toHaveLength(1)
      expect(window.webContents.debugger.sendCommand).toHaveBeenCalledOnce()
      expect(deadlines).toHaveBeenCalledTimes(2)
      expect(window.destroy).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      store.dispose()
      deadlines.mockRestore()
    }
  })

  it('preserves FIFO mutation ordering when the first target is retired before its queued write executes', async () => {
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
    let releaseMutation!: () => void
    let queue = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    let value = 'working'
    const mutations: string[] = []
    const firstStore = openCookieClearStore(owner)
    const first = withCookieMutationLock(owner, async () => {
      try {
        await firstStore.writeCookieIdentity(row)
      } finally {
        firstStore.dispose()
      }
    })
    const firstFailure = expect(first).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(0)
    electron.windows[0].webContents.debugger.sendCommand.mockImplementation(() => {
      queue = queue.then(() => {
        value = 'old'
        mutations.push(value)
      })
      return new Promise(() => {})
    })
    electron.windows[0].resolveLoad()
    await vi.advanceTimersByTimeAsync(10_000)
    await firstFailure
    expect(value).toBe('working')
    const second = withCookieMutationLock(owner, async () => {
      const store = openCookieClearStore(owner)
      try {
        await store.writeCookieIdentity({ ...row, value: 'new' })
      } finally {
        store.dispose()
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    electron.windows[1].webContents.debugger.sendCommand.mockImplementation(() => {
      queue = queue.then(() => {
        value = 'new'
        mutations.push(value)
      })
      return queue.then(() => ({ success: true }))
    })
    electron.windows[1].resolveLoad()
    releaseMutation()
    await second
    expect(mutations).toEqual(['old', 'new'])
    expect(value).toBe('new')
  })
})
