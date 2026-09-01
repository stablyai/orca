import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

const electron = vi.hoisted(() => {
  const windows: BrowserWindow[] = []

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

  return { BrowserWindow, windows }
})

const lease = vi.hoisted(() => ({ release: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow
}))
vi.mock('./electron-debugger-lease', () => ({
  acquireElectronDebugger: vi.fn(() => lease)
}))

import { openCookieClearStore } from './browser-cookie-clear-store'

function targetSession(): Session {
  return { cookies: { get: vi.fn(), remove: vi.fn() } } as unknown as Session
}

describe('cookie clear debugger lifecycle', () => {
  beforeEach(() => {
    electron.windows.length = 0
    lease.release.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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
    await expect(snapshot).rejects.toThrow(/disposed during debugger attachment/)
    expect(lease.release).toHaveBeenCalledOnce()
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

  it('classifies a retired command after a bounded settlement grace', async () => {
    vi.useFakeTimers()
    let resolveCommand!: (value: unknown) => void
    const pendingCommand = new Promise<unknown>((resolve) => {
      resolveCommand = resolve
    })
    const store = openCookieClearStore(targetSession())
    const write = store.writeCookieIdentity({
      url: 'https://late.example/',
      name: 'late',
      value: 'value',
      sameSite: 'unspecified'
    })
    const window = electron.windows[0]
    window.webContents.debugger.sendCommand.mockReturnValueOnce(pendingCommand)
    window.resolveLoad()
    const timeoutExpectation = expect(write).rejects.toMatchObject({
      name: 'CookieDebuggerCommandTimeoutError',
      message: 'Cookie debugger command Network.setCookie timed out after 10000ms'
    })
    await vi.advanceTimersByTimeAsync(11_000)

    expect(lease.release).toHaveBeenCalledOnce()
    expect(window.destroy).toHaveBeenCalledOnce()
    await timeoutExpectation

    resolveCommand({ success: true })
    await Promise.resolve()
    store.dispose()
    expect(lease.release).toHaveBeenCalledOnce()
  })
})
