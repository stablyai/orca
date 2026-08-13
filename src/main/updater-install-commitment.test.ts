import { beforeEach, describe, expect, it, vi } from 'vitest'

const windows: { destroyed: boolean; sent: [string, boolean][] }[] = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () =>
      windows.map((w) => ({
        isDestroyed: () => w.destroyed,
        webContents: {
          send: (channel: string, committed: boolean) => {
            if (w.destroyed) {
              throw new Error('window destroyed')
            }
            w.sent.push([channel, committed])
          }
        }
      }))
  }
}))

const { BrowserWindow } = await import('electron')
const {
  UPDATER_INSTALL_COMMITTED_CHANNEL,
  clearUpdaterInstallCommitted,
  isUpdaterInstallCommitted,
  markUpdaterInstallCommitted,
  resetUpdaterInstallCommitmentForTest
} = await import('./updater-install-commitment')

function addWindow(destroyed = false): { destroyed: boolean; sent: [string, boolean][] } {
  const w = { destroyed, sent: [] as [string, boolean][] }
  windows.push(w)
  return w
}

describe('updater install commitment', () => {
  beforeEach(() => {
    windows.length = 0
    resetUpdaterInstallCommitmentForTest()
  })

  it('reaches every live window, not only the one that pressed Restart', () => {
    const main = addWindow()
    const popout = addWindow()

    markUpdaterInstallCommitted()

    // The popout reads its lazy chunks from the same archive the installer swaps.
    expect(main.sent).toEqual([[UPDATER_INSTALL_COMMITTED_CHANNEL, true]])
    expect(popout.sent).toEqual([[UPDATER_INSTALL_COMMITTED_CHANNEL, true]])
    expect(isUpdaterInstallCommitted()).toBe(true)
  })

  it('keeps installing when one window is already gone', () => {
    addWindow(true)
    const alive = addWindow()

    expect(() => markUpdaterInstallCommitted()).not.toThrow()
    expect(alive.sent).toEqual([[UPDATER_INSTALL_COMMITTED_CHANNEL, true]])
  })

  it('stands the archive back up only on a real abort', () => {
    const win = addWindow()
    markUpdaterInstallCommitted()
    win.sent.length = 0

    clearUpdaterInstallCommitted()

    expect(isUpdaterInstallCommitted()).toBe(false)
    expect(win.sent).toEqual([[UPDATER_INSTALL_COMMITTED_CHANNEL, false]])
  })

  it('never lets a hostile window break the install', () => {
    // Regression: an earlier revision called isDestroyed() outside the try, so a
    // window lacking it threw straight out of the install path and aborted the
    // update. Notifying renderers is best effort; installing is not.
    windows.push({
      get destroyed(): boolean {
        throw new Error('not a real window')
      },
      sent: []
    } as never)
    const alive = addWindow()

    expect(() => markUpdaterInstallCommitted()).not.toThrow()
    expect(alive.sent).toEqual([[UPDATER_INSTALL_COMMITTED_CHANNEL, true]])
    expect(isUpdaterInstallCommitted()).toBe(true)
  })

  it('survives getAllWindows itself throwing', () => {
    // The outer boundary matters for the same reason as the inner one: this runs
    // inside the install path.
    const spy = vi.spyOn(BrowserWindow, 'getAllWindows').mockImplementation(() => {
      throw new Error('electron is tearing down')
    })

    expect(() => markUpdaterInstallCommitted()).not.toThrow()
    expect(isUpdaterInstallCommitted()).toBe(true)
    spy.mockRestore()
  })

  it('does not broadcast a clear that changes nothing', () => {
    const win = addWindow()

    clearUpdaterInstallCommitted()

    // Otherwise an unrelated updater error would churn every renderer.
    expect(win.sent).toEqual([])
  })
})
