import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: any[]) => void
const electron = vi.hoisted(() => {
  const beforeQuit: Listener[] = []
  const powerListeners: Record<string, Listener> = {}
  return { beforeQuit, powerListeners, quit: vi.fn() }
})

vi.mock('electron', () => ({
  app: {
    quit: electron.quit,
    prependListener: (event: string, listener: Listener) => {
      if (event === 'before-quit') {
        electron.beforeQuit.unshift(listener)
      }
    }
  },
  powerMonitor: {
    on: (event: string, listener: Listener) => {
      electron.powerListeners[event] = listener
    }
  }
}))

import { installServeNativeQuitGuard } from './serve-native-quit-guard'
import { quitProcess, resetProcessQuitRequestForTest } from './process-quit-request'

function emitBeforeQuit(): { preventDefault: ReturnType<typeof vi.fn> } {
  const event = { preventDefault: vi.fn() }
  for (const listener of electron.beforeQuit) {
    listener(event)
  }
  return event
}

describe('installServeNativeQuitGuard', () => {
  const closeDesktopWindows = vi.fn()
  const isQuittingForUpdate = vi.fn(() => false)

  beforeEach(() => {
    electron.beforeQuit.length = 0
    for (const key of Object.keys(electron.powerListeners)) {
      delete electron.powerListeners[key]
    }
    electron.quit.mockReset()
    closeDesktopWindows.mockReset()
    isQuittingForUpdate.mockReturnValue(false)
    resetProcessQuitRequestForTest()
  })

  it('turns a macOS Dock or app-switcher Quit into closing the desktop windows (#15537)', () => {
    installServeNativeQuitGuard({ platform: 'darwin', isQuittingForUpdate, closeDesktopWindows })

    const event = emitBeforeQuit()

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(closeDesktopWindows).toHaveBeenCalledOnce()
  })

  it('lets a signal, supervisor or relaunch quit through, and keeps it allowed on re-entry', () => {
    installServeNativeQuitGuard({ platform: 'darwin', isQuittingForUpdate, closeDesktopWindows })

    quitProcess()
    expect(electron.quit).toHaveBeenCalledOnce()
    // will-quit's second pass calls app.quit() again.
    expect(emitBeforeQuit().preventDefault).not.toHaveBeenCalled()
    expect(emitBeforeQuit().preventDefault).not.toHaveBeenCalled()
    expect(closeDesktopWindows).not.toHaveBeenCalled()
  })

  it('lets an update install quit through', () => {
    isQuittingForUpdate.mockReturnValue(true)
    installServeNativeQuitGuard({ platform: 'darwin', isQuittingForUpdate, closeDesktopWindows })

    expect(emitBeforeQuit().preventDefault).not.toHaveBeenCalled()
  })

  it('does not cancel a macOS logout or shutdown', () => {
    installServeNativeQuitGuard({ platform: 'darwin', isQuittingForUpdate, closeDesktopWindows })

    electron.powerListeners.shutdown?.()

    expect(emitBeforeQuit().preventDefault).not.toHaveBeenCalled()
    expect(closeDesktopWindows).not.toHaveBeenCalled()
  })

  it.each(['linux', 'win32'] as const)('installs nothing on %s', (platform) => {
    installServeNativeQuitGuard({ platform, isQuittingForUpdate, closeDesktopWindows })

    expect(electron.beforeQuit).toHaveLength(0)
    expect(electron.powerListeners).toEqual({})
  })
})
