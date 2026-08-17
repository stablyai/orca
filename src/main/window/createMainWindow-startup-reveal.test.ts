import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { createMainWindow } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  browserWindowMock,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'

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
      send: vi.fn()
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
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
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

  it('does not install the startup reveal fallback on macOS', () => {
    vi.useFakeTimers()
    const { browserWindowInstance } = createStartupRevealWindowFixture()

    withPlatform('darwin', () => {
      createMainWindow(null)
      vi.advanceTimersByTime(10_000)

      expect(browserWindowInstance.show).not.toHaveBeenCalled()
      expect(browserWindowInstance.maximize).not.toHaveBeenCalled()
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
