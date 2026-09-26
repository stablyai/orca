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
vi.mock('../browser/browser-client-page-renderer-runtime', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    attachBrowserClientPageRenderer: harness.attachClientPageRendererMock,
    retireBrowserClientPageRenderer: harness.retireClientPageRendererMock
  }
})

import { createMainWindow } from './createMainWindow'
import { browserWindowMock, isMock, resetMainWindowMocks } from './createMainWindow-test-harness'
import {
  RENDERER_BOOTSTRAP_CONFIRM_DEV_TIMEOUT_MS,
  RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS
} from './renderer-bootstrap-liveness'
import { notifyRendererBootstrapped } from './renderer-bootstrap-signal'
import { RENDERER_RECOVERY_LOAD_TIMEOUT_MS } from './renderer-recovery-reload-watchdog'

const RENDERER_ID = 143
const CRASH: Electron.RenderProcessGoneDetails = { reason: 'crashed', exitCode: 1 }

/**
 * Field regression (bundle F0C17E8TVU0, Orca 1.4.198, Windows 10.0.26200):
 *   16:38:41.577  the renderer's own lazy-chunk recovery called location.reload()
 *   16:38:44.958  the replacement document's entry module never fetched, yet did-finish-load
 *                 fired and main recorded main_window_loaded as a SUCCESS
 *   16:38-16:56   17m23s of a white window: no renderer_bootstrap_started, and not one of the
 *                 60s renderer memory samples this install had emitted 2990 times that day
 * did-finish-load was the entire success test, so a document whose JavaScript never ran was
 * indistinguishable from a healthy one and nothing ever reconsidered it.
 */
describe('renderer bootstrap liveness', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    vi.useFakeTimers()
  })

  const createHarness = () => {
    const registered: Record<string, ((...args: unknown[]) => void)[]> = {}
    const windowHandlers: Record<string, (...args: unknown[]) => void> = {}
    const register = (event: string, handler: (...args: unknown[]) => void): void => {
      const handlers = (registered[event] ??= [])
      handlers.push(handler)
      windowHandlers[event] ??= (...args: unknown[]) => {
        for (const listener of handlers.slice()) {
          listener(...args)
        }
      }
    }
    const settleLoad: { resolve: () => void; reject: (error: Error) => void }[] = []
    const pendingLoad = (): Promise<void> =>
      new Promise<void>((resolve, reject) => settleLoad.push({ resolve, reject }))
    const webContents = {
      id: RENDERER_ID,
      getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(register),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(register),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      setWindowButtonPosition: vi.fn(),
      loadFile: vi.fn(pendingLoad),
      loadURL: vi.fn(pendingLoad)
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    /** What Chromium emits for a document that parses and finishes but never runs its entry module. */
    const landDocumentWithoutBootstrap = (): void => {
      windowHandlers['did-navigate']?.()
      windowHandlers['dom-ready']?.()
      windowHandlers['did-finish-load']?.()
    }
    const crashRenderer = (): void => {
      windowHandlers['render-process-gone']?.({} as never, CRASH)
      vi.advanceTimersByTime(250)
    }
    return {
      browserWindowInstance,
      consoleError,
      crashRenderer,
      landDocumentWithoutBootstrap,
      settleLoad,
      windowHandlers
    }
  }

  it('reloads a document that loaded but never ran its JavaScript, then hands over the prompt', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, landDocumentWithoutBootstrap, settleLoad } =
      createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    settleLoad[0]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    landDocumentWithoutBootstrap()

    // The whole budget must elapse before anything reloads a window that may still be booting.
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS - 1)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'blank' })
    )
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    // The replacement is blank too: recovery is spent, so the user gets the Reload/Quit surface
    // instead of another 17 minutes of white window.
    settleLoad[1]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    landDocumentWithoutBootstrap()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)

    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'bootstrap-absent', webContentsId: RENDERER_ID })
    )
    // Bounded: no third automatic reload behind the prompt.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    consoleError.mockRestore()
  })

  it('re-arms after a healthy document, catching the renderer-initiated reload that lands blank', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const {
      browserWindowInstance,
      consoleError,
      landDocumentWithoutBootstrap,
      settleLoad,
      windowHandlers
    } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    settleLoad[0]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    // The field bundle's first document booted and ran for a day; only its replacement was blank.
    windowHandlers['did-navigate']?.()
    notifyRendererBootstrapped(RENDERER_ID)
    windowHandlers['did-finish-load']?.()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS * 4)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)

    // 16:38:41 — lazy-chunk recovery reloads through the renderer, so no recovery reload was ever
    // issued and the stall watchdog holds no attempt. The confirmation the healthy document gave
    // belongs to it alone: carrying it over is what left the replacement unwatched for 17m23s.
    landDocumentWithoutBootstrap()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)

    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'blank' })
    )
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    consoleError.mockRestore()
  })

  it('spends a fresh reload on a later blank document once a boot has been confirmed', async () => {
    const onRendererRecoveryExhausted = vi.fn()
    const {
      browserWindowInstance,
      consoleError,
      landDocumentWithoutBootstrap,
      settleLoad,
      windowHandlers
    } = createHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })
    settleLoad[0]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    landDocumentWithoutBootstrap()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    // That reload's document boots, so the session is healthy again.
    settleLoad[1]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    windowHandlers['did-navigate']?.()
    notifyRendererBootstrapped(RENDERER_ID)
    windowHandlers['did-finish-load']?.()

    // A second, independent blank hours later is not the first one's second strike: it gets the
    // automatic reload that fixed the first, not the prompt.
    landDocumentWithoutBootstrap()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('does not reload behind the prompt a stalled recovery already raised', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, landDocumentWithoutBootstrap } =
      createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    // Both recovery attempts stall, so the user is looking at the Reload/Quit message box.
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'reload-stalled' })
    )
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    // A document finally lands under the box and is blank. A native message box cannot be
    // dismissed programmatically, so reloading now would destroy the session behind a prompt the
    // user is still answering.
    landDocumentWithoutBootstrap()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'blank' })
    )

    consoleError.mockRestore()
  })

  it('never reloads a slow but healthy boot, whichever side of did-finish-load confirms it', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, settleLoad, windowHandlers } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    settleLoad[0]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    windowHandlers['did-navigate']?.()
    // The entry module runs before the load event, so the confirmation normally precedes
    // did-finish-load; arming a deadline that is already satisfied would reload a working app.
    notifyRendererBootstrapped(RENDERER_ID)
    windowHandlers['did-finish-load']?.()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS * 4)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    // A confirmation that lands after did-finish-load — main was busy — disarms it just as well.
    windowHandlers['did-navigate']?.()
    windowHandlers['did-finish-load']?.()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS - 1)
    notifyRendererBootstrapped(RENDERER_ID)
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS * 4)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('gives a Vite dev boot the same long budget the recovery load already gets', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { browserWindowInstance, consoleError, landDocumentWithoutBootstrap, settleLoad } =
      createHarness()
    isMock.dev = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/')

    try {
      createMainWindow(null, { onRecoveryReloadOutcome })
      settleLoad[0]?.resolve()
      await vi.advanceTimersByTimeAsync(0)
      landDocumentWithoutBootstrap()

      // A cold Vite start refetches the whole module graph; the packaged budget would reload it.
      vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS * 2)
      expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
      expect(browserWindowInstance.loadURL).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_DEV_TIMEOUT_MS)
      expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'blank' })
      )
    } finally {
      vi.unstubAllEnvs()
      consoleError.mockRestore()
    }
  })

  // The 250ms between render-process-gone and the reload it queues is the only window in which
  // isRecoveryPending is the term that holds the gate back; after it, the in-flight load does.
  it('leaves the blank document alone in the gap before a queued crash recovery reloads', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const {
      browserWindowInstance,
      consoleError,
      landDocumentWithoutBootstrap,
      settleLoad,
      windowHandlers
    } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    settleLoad[0]?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    landDocumentWithoutBootstrap()

    // The renderer dies 100ms short of the bootstrap deadline, which then expires while that
    // death's own recovery is still queued — 250ms of it has not elapsed yet.
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS - 100)
    windowHandlers['render-process-gone']?.({} as never, CRASH)
    vi.advanceTimersByTime(100)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()

    // The queued recovery still owns the reload, and it is the only one issued.
    vi.advanceTimersByTime(150)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 3)
    consoleError.mockRestore()
  })

  // `inFlight`, not isRecoveryPending: crashRenderer() advances past the 250ms queue, so the
  // recovery reload has already been issued by the time the deadline expires.
  it('does not let a bootstrap timeout race the crash-recovery reload it is waiting on', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, landDocumentWithoutBootstrap } =
      createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    landDocumentWithoutBootstrap()
    // A renderer death queues its own recovery, which owns the next load.
    crashRenderer()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)
    // No extra reload stacked on the crash recovery's in-flight load.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 3)
    consoleError.mockRestore()
  })
})
