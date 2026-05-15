import { describe, expect, it, vi } from 'vitest'
import { acquireElectronDebugger } from './electron-debugger-lease'

function createWebContents(attached = false) {
  let isAttached = attached
  return {
    isDestroyed: vi.fn(() => false),
    debugger: {
      isAttached: vi.fn(() => isAttached),
      attach: vi.fn(() => {
        isAttached = true
      }),
      detach: vi.fn(() => {
        isAttached = false
      })
    }
  }
}

describe('electron debugger lease', () => {
  it('detaches only after the final lease releases', () => {
    const webContents = createWebContents()

    const first = acquireElectronDebugger(webContents as never)
    const second = acquireElectronDebugger(webContents as never)

    first.release()
    expect(webContents.debugger.detach).not.toHaveBeenCalled()

    second.release()
    expect(webContents.debugger.attach).toHaveBeenCalledTimes(1)
    expect(webContents.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('does not detach a debugger it did not attach', () => {
    const webContents = createWebContents(true)

    const lease = acquireElectronDebugger(webContents as never)
    lease.release()

    expect(webContents.debugger.attach).not.toHaveBeenCalled()
    expect(webContents.debugger.detach).not.toHaveBeenCalled()
  })
})
