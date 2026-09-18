import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { app } from 'electron'
import { createMainWindow } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  browserWindowMock,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'

// These cases exercise foreground behavior against Electron mocks.
beforeEach(() => {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
  vi.stubEnv('ORCA_E2E_HEADLESS', undefined)
  vi.stubEnv('ORCA_E2E_HEADFUL', undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  function createStartupRevealWindowFixture() {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      once: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      setWindowButtonPosition: vi.fn(),
      maximize: vi.fn(() => {
        windowHandlers['maximize']?.()
      }),
      show: vi.fn(),
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    return { browserWindowInstance, windowHandlers }
  }

  function createStartupRevealStore(savedMaximized: boolean) {
    return {
      getUI: () =>
        ({
          windowMaximized: savedMaximized
        }) as never,
      getSettings: () => ({ windowBackgroundBlur: false }) as never,
      updateUI: vi.fn()
    }
  }

  it.each(['darwin', 'linux', 'win32'] as const)(
    'keeps explicit background startup hidden through ready/load/fallback on %s',
    (platform) => {
      vi.useFakeTimers()
      vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
      const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
      const showInactive = vi.fn()
      Object.assign(browserWindowInstance, { showInactive })
      try {
        withPlatform(platform, () => {
          createMainWindow(createStartupRevealStore(true) as never, { revealOnDidFinishLoad: true })
          const revealAfterLoad = browserWindowInstance.webContents.on.mock.calls.find(
            ([event]) => event === 'did-finish-load'
          )?.[1]
          expect(revealAfterLoad).toBeTypeOf('function')
          revealAfterLoad?.()
          windowHandlers['ready-to-show']()
          vi.advanceTimersByTime(10_000)
          expect(browserWindowInstance.show).not.toHaveBeenCalled()
          expect(showInactive).not.toHaveBeenCalled()
          expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
        })
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )

  it('ignores duplicate ready-to-show events after startup maximize has already run', () => {
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    createMainWindow({
      getUI: () =>
        ({
          windowMaximized: true
        }) as never,
      getSettings: () => ({ windowBackgroundBlur: false }) as never,
      updateUI: vi.fn()
    } as never)

    windowHandlers['ready-to-show']()
    windowHandlers['ready-to-show']()

    expect(browserWindowInstance.maximize).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
  })

  it('can reveal the startup window after renderer load before ready-to-show', () => {
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    createMainWindow(null, { revealOnDidFinishLoad: true })
    const revealAfterLoad = browserWindowInstance.webContents.on.mock.calls.find(
      ([event]) => event === 'did-finish-load'
    )?.[1]
    expect(revealAfterLoad).toBeTypeOf('function')
    revealAfterLoad?.()

    expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    windowHandlers['ready-to-show']()
    expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
  })

  it('reveals the startup window on Windows when ready-to-show never fires', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('win32', () => {
      createMainWindow(null)
      vi.advanceTimersByTime(9_999)
      expect(browserWindowInstance.show).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)

      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  it('cancels the Windows startup reveal fallback after ready-to-show', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('win32', () => {
      createMainWindow(null)
      windowHandlers['ready-to-show']()
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  it('reveals the startup window on Linux when ready-to-show never fires', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('linux', () => {
      createMainWindow(null)
      vi.advanceTimersByTime(9_999)
      expect(browserWindowInstance.show).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)

      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  it('cancels the Linux startup reveal fallback after ready-to-show', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('linux', () => {
      createMainWindow(null)
      windowHandlers['ready-to-show']()
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  // Field: darwin SIGTRAP-at-startup (reports fa0a6033 / 8468e3ec, one machine, 9 launches in 77 min).
  // GPU, network service and renderer all trap 195-738ms after main_window_created, before any paint,
  // so ready-to-show never fires and macOS had no fallback: the app ran with no window at all.
  it('reveals the startup window on macOS when ready-to-show never fires', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('darwin', () => {
      createMainWindow(null)
      vi.advanceTimersByTime(9_999)
      expect(browserWindowInstance.show).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  // The fallback timer is not enough on its own: in fa0a6033 the main thread wedged ~5.5s after the
  // window was created, before the 10s timer could run. The death itself is the signal.
  it('reveals the startup window as soon as the renderer dies before first paint', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('darwin', () => {
      createMainWindow(null)
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  // Project rule: an automated/background launch must never be forced on screen. The pre-paint
  // death reveal is a second entry point into revealInitialWindow and has to honour it too.
  it('keeps an explicit background launch hidden when the renderer dies before first paint', () => {
    vi.useFakeTimers()
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    const showInactive = vi.fn()
    Object.assign(browserWindowInstance, { showInactive })

    withPlatform('darwin', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(showInactive).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
    })
  })

  // The reveal is best-effort UI; the crash record and the recovery reload behind it are not.
  it('still records the crash and schedules recovery when the pre-paint reveal throws', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    browserWindowInstance.show.mockImplementation(() => {
      throw new Error('NSWindow orderFront failed')
    })
    const onRendererProcessGone = vi.fn()

    withPlatform('darwin', () => {
      createMainWindow(null, { onRendererProcessGone })
      const loadsBefore = browserWindowInstance.loadFile.mock.calls.length
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(onRendererProcessGone).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(250)
      expect(browserWindowInstance.loadFile.mock.calls.length).toBeGreaterThan(loadsBefore)

      // A failed reveal must not latch the window hidden: the recovered load gets another chance.
      browserWindowInstance.show.mockImplementation(() => undefined)
      windowHandlers['ready-to-show']()
      expect(browserWindowInstance.show).toHaveBeenCalledTimes(2)
    })
  })

  // A maximized last session must not cost the reveal: maximize() notifies the renderer, and on this
  // path the renderer is already dead, so the notification throws straight out of maximize().
  it('reveals the window even when restoring maximized geometry throws', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    browserWindowInstance.maximize.mockImplementation(() => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    })

    withPlatform('darwin', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(browserWindowInstance.maximize).toHaveBeenCalledTimes(1)
      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  // The maximize notification is the throw source; a dead frame must be skipped, not sent to.
  it('skips the maximize notification when the renderer frame is gone', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    browserWindowInstance.webContents.isCrashed.mockReturnValue(true)

    withPlatform('darwin', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(browserWindowInstance.webContents.send).not.toHaveBeenCalledWith(
        'window:maximize-changed',
        true
      )
      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  // The fallback is the only reveal signal when no first frame ever arrives, so a throw inside it must
  // re-arm rather than spend it — otherwise a failed last resort latches the window hidden for good.
  it('re-arms the reveal fallback when the fallback reveal itself throws', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()
    browserWindowInstance.show.mockImplementation(() => {
      throw new Error('NSWindow orderFront failed')
    })

    withPlatform('darwin', () => {
      createMainWindow(null)
      vi.advanceTimersByTime(10_000)
      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)

      browserWindowInstance.show.mockImplementation(() => undefined)
      vi.advanceTimersByTime(10_000)
      expect(browserWindowInstance.show).toHaveBeenCalledTimes(2)
    })
  })

  // Project rule: a headful automated run may put a window up but must never take the foreground.
  it('reveals a headful automated launch without stealing focus', () => {
    vi.useFakeTimers()
    vi.stubEnv('ORCA_E2E_HEADFUL', '1')
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    const showInactive = vi.fn()
    Object.assign(browserWindowInstance, { showInactive })

    withPlatform('darwin', () => {
      createMainWindow(null)
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(showInactive).toHaveBeenCalledTimes(1)
      expect(browserWindowInstance.show).not.toHaveBeenCalled()
    })
  })

  // Teardown must not resurrect a window: a renderer dying during quit is noise, not a pre-paint death.
  it('does not reveal when the renderer dies while the app is quitting', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('darwin', () => {
      createMainWindow(null, { getIsQuitting: () => true })
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
    })
  })

  // Closing a window kills its renderer, so the pre-paint reveal must not re-show what the user just
  // closed. This pins the isWindowClosing half of the guard; the quitting half is pinned above.
  it('does not reveal when the renderer dies while the window is closing', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    const showInactive = vi.fn()
    Object.assign(browserWindowInstance, { showInactive })

    withPlatform('darwin', () => {
      createMainWindow(null)
      // Why before-quit: the auto-updater strips 'close' listeners, so this is where the latch is set.
      const freezeBoundsOnQuit = (
        app.on as unknown as { mock: { calls: [string, () => void][] } }
      ).mock.calls.findLast(([event]) => event === 'before-quit')?.[1]
      expect(freezeBoundsOnQuit).toBeTypeOf('function')
      freezeBoundsOnQuit?.()
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(showInactive).not.toHaveBeenCalled()
    })
  })

  // The liveness probes cannot catch a frame that dies between the check and the send, so the send is
  // wrapped too. Without the wrapper the throw escapes maximize() and starves the reveal again.
  it('reveals the window when the maximize notification throws despite a live-looking frame', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    browserWindowInstance.webContents.send.mockImplementation(() => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    })

    withPlatform('darwin', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(browserWindowInstance.webContents.send).toHaveBeenCalledWith(
        'window:maximize-changed',
        true
      )
      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  // Pins the isDestroyed term: a destroyed frame must be skipped outright, not probed by the try/catch.
  it('skips the maximize notification when the renderer frame is destroyed', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    browserWindowInstance.webContents.isDestroyed.mockReturnValue(true)

    withPlatform('darwin', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      windowHandlers['render-process-gone']({}, { reason: 'crashed', exitCode: 5 })

      expect(browserWindowInstance.webContents.send).not.toHaveBeenCalledWith(
        'window:maximize-changed',
        true
      )
      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  // The send sits BEFORE bounds persistence on the unmaximize path, so an unwrapped throw would lose the
  // user's restored window size. This is what the try/catch inside sendMaximizeChanged actually buys.
  it('still persists restored bounds when the unmaximize notification throws', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()
    Object.assign(browserWindowInstance, {
      getBounds: vi.fn(() => ({ x: 10, y: 20, width: 1100, height: 700 }))
    })
    browserWindowInstance.webContents.send.mockImplementation(() => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    })
    const store = createStartupRevealStore(false)

    withPlatform('darwin', () => {
      createMainWindow(store as never)
      windowHandlers['unmaximize']()

      expect(store.updateUI).toHaveBeenCalledWith({
        windowMaximized: false,
        windowBounds: { x: 10, y: 20, width: 1100, height: 700 }
      })
    })
  })

  it('cancels the macOS startup reveal fallback after ready-to-show', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('darwin', () => {
      createMainWindow(null)
      windowHandlers['ready-to-show']()
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps the headless E2E window hidden when the Windows fallback fires', () => {
    vi.useFakeTimers()
    const previousHeadless = process.env.ORCA_E2E_HEADLESS
    process.env.ORCA_E2E_HEADLESS = '1'
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    try {
      withPlatform('win32', () => {
        createMainWindow(createStartupRevealStore(true) as never)
        vi.advanceTimersByTime(10_000)

        expect(browserWindowInstance.show).not.toHaveBeenCalled()
        expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
      })
    } finally {
      if (previousHeadless === undefined) {
        delete process.env.ORCA_E2E_HEADLESS
      } else {
        process.env.ORCA_E2E_HEADLESS = previousHeadless
      }
    }
  })

  it('clears the Windows startup reveal fallback when the window is closed', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('win32', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      windowHandlers.closed()
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
    })
  })

  it('does not show or maximize a destroyed window when the Windows fallback fires', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('win32', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      browserWindowInstance.isDestroyed.mockReturnValue(true)
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
    })
  })

  it('keeps the headless E2E window hidden when the Linux fallback fires', () => {
    vi.useFakeTimers()
    const previousHeadless = process.env.ORCA_E2E_HEADLESS
    process.env.ORCA_E2E_HEADLESS = '1'
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    try {
      withPlatform('linux', () => {
        createMainWindow(createStartupRevealStore(true) as never)
        vi.advanceTimersByTime(10_000)

        expect(browserWindowInstance.show).not.toHaveBeenCalled()
        expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
      })
    } finally {
      if (previousHeadless === undefined) {
        delete process.env.ORCA_E2E_HEADLESS
      } else {
        process.env.ORCA_E2E_HEADLESS = previousHeadless
      }
    }
  })

  it('clears the Linux startup reveal fallback when the window is closed', () => {
    vi.useFakeTimers()
    const { browserWindowInstance, windowHandlers } = createStartupRevealWindowFixture()

    withPlatform('linux', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      windowHandlers.closed()
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
    })
  })

  it('does not show or maximize a destroyed window when the Linux fallback fires', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('linux', () => {
      createMainWindow(createStartupRevealStore(true) as never)
      browserWindowInstance.isDestroyed.mockReturnValue(true)
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
    })
  })
})
