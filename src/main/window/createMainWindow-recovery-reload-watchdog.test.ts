import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DurableCrashBreadcrumbModule from '../crash-reporting/durable-crash-breadcrumb'

const { recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordDurableCrashBreadcrumbMock: vi.fn()
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', async (importOriginal) => ({
  ...(await importOriginal<typeof DurableCrashBreadcrumbModule>()),
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

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
import {
  browserWindowMock,
  isMock,
  powerMonitorOnMock,
  resetMainWindowMocks
} from './createMainWindow-test-harness'
import {
  RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS,
  RENDERER_RECOVERY_LOAD_TIMEOUT_MS
} from './renderer-recovery-reload-watchdog'

const DOCUMENT_URL = 'file:///opt/orca/renderer/index.html'
// A real macOS install URL: the crash-report redactor's PATH_PATTERNS provably leave this one intact.
const INSTALL_PATH_LOAD_ERROR =
  "ERR_FILE_NOT_FOUND (-6) loading 'file:///Users/jane.doe/Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'"
const CRASH = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails

/**
 * Regression cover for the field failure: the recovery reload is issued, never produces a document, and nothing
 * notices — no did-fail-load, no breaker (it counts renderer deaths only), no retry, no prompt.
 */
describe('renderer recovery reload watchdog', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    recordDurableCrashBreadcrumbMock.mockClear()
    vi.useFakeTimers()
  })

  const createHarness = () => {
    // Why fan-out: dom-ready and did-finish-load have several real registrants on this one webContents, so
    // last-writer-wins would silently drop the watchdog's listener if registration order ever changed.
    const registered: Record<string, ((...args: any[]) => void)[]> = {}
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const register = (event: string, handler: (...args: any[]) => void): void => {
      const handlers = (registered[event] ??= [])
      handlers.push(handler)
      windowHandlers[event] ??= (...args: any[]) => {
        for (const listener of handlers.slice()) {
          listener(...args)
        }
      }
    }
    // Loads stay pending unless a test settles one: that is exactly the stall being reproduced.
    const settleLoad: { resolve: () => void; reject: (error: Error) => void }[] = []
    const pendingLoad = (): Promise<void> =>
      new Promise<void>((resolve, reject) => settleLoad.push({ resolve, reject }))
    const webContents = {
      id: 143,
      getURL: vi.fn(() => DOCUMENT_URL),
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
    const crashRenderer = (): void => {
      windowHandlers['render-process-gone']?.({} as never, CRASH)
      vi.advanceTimersByTime(250)
    }
    const reachMilestone = (milestone: 'committed' | 'dom-ready'): void =>
      windowHandlers[milestone === 'committed' ? 'did-navigate' : 'dom-ready']?.()
    return {
      browserWindowInstance,
      consoleError,
      crashRenderer,
      reachMilestone,
      settleLoad,
      windowHandlers
    }
  }

  it('retries once when the recovery reload never produces a document, then hands the user the prompt', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    // 1 initial load + 1 recovery reload, which now stalls forever.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS - 1)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1)
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith({
      status: 'timeout',
      attempt: 1,
      elapsedMs: RENDERER_RECOVERY_LOAD_TIMEOUT_MS,
      progress: 'none'
    })
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(onRecoveryReloadOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'timeout', attempt: 2 })
    )
    // Retry budget spent: stop reloading and surface the only retry/quit surface the user has.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith({
      details: CRASH,
      webContentsId: 143,
      recentRecoveryCount: 1,
      cause: 'reload-stalled',
      retry: expect.any(Function)
    })

    consoleError.mockRestore()
  })

  it('clears the watchdog when the recovery reload finishes loading', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(2_000)
    settleLoad[1]?.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith({
      status: 'loaded',
      attempt: 1,
      elapsedMs: 2_000
    })

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 3)
    expect(onRecoveryReloadOutcome).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('keeps watching the retry when a stale did-finish-load arrives after it was issued', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, windowHandlers } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    // did-finish-load carries no attempt token: this one belongs to the load the timer just abandoned. Crediting
    // the retry with it disarms the watchdog over a load still in flight — the exact hole this watchdog closes.
    windowHandlers['did-finish-load']?.()
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'loaded' })
    )

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(onRecoveryReloadOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'timeout', attempt: 2 })
    )
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)

    consoleError.mockRestore()
  })

  it('does not take an error page as the retry landing', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { consoleError, crashRenderer, settleLoad, windowHandlers } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    settleLoad[1]?.reject(new Error('ERR_FILE_NOT_FOUND (-6)'))
    await vi.advanceTimersByTimeAsync(0)
    // Chromium commits an error document for the failed load, and that document emits did-finish-load too.
    windowHandlers['did-finish-load']?.()

    expect(onRecoveryReloadOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'loaded' })
    )
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)

    consoleError.mockRestore()
  })

  it('raises one prompt, however many times recovery gives up underneath it', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    // The renderer dies again while the box is up; the breaker never counted stalls, so it lets the reload go.
    crashRenderer()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)

    // Nothing dismisses a native message box: a retry the user never asked for, or a second box, stacks on it.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    // The stall is still on the record, so the bundle does not read as a recovery that quietly worked.
    expect(onRecoveryReloadOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'timeout', attempt: 1 })
    )

    // Answering the box with Reload hands the next verdict back to the user.
    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(2)

    consoleError.mockRestore()
  })

  it('still reloads from a crash-loop prompt raised after an earlier recovery had landed', async () => {
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })
    // Every recovery reload lands, and every landed document then dies with its renderer.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      crashRenderer()
      settleLoad[attempt]?.resolve()
      await vi.advanceTimersByTimeAsync(0)
    }
    crashRenderer()
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    const loads = browserWindowInstance.loadFile.mock.calls.length

    // The last document landed, but the renderer took it down: declining Reload here strands the user.

    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(loads + 1)

    consoleError.mockRestore()
  })

  it('does not stack a crash-loop prompt on one that is already up', () => {
    const onRendererRecoveryExhausted = vi.fn()
    const { consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      crashRenderer()
    }

    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)

    consoleError.mockRestore()
  })

  it('escalates a rejected recovery load immediately instead of waiting out the watchdog', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    crashRenderer()
    settleLoad[1]?.reject(new Error("ERR_FILE_NOT_FOUND (-6) loading 'file:///opt/orca'"))
    await vi.advanceTimersByTimeAsync(0)

    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        attempt: 1,
        errorCode: 'ERR_FILE_NOT_FOUND'
      })
    )
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    consoleError.mockRestore()
  })

  it('ignores a superseded load rejection so ERR_ABORTED never escalates', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    // A second renderer death supersedes the first reload; Chromium rejects the abandoned load with ERR_ABORTED.
    crashRenderer()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
    settleLoad[1]?.reject(new Error('ERR_ABORTED (-3)'))
    await vi.advanceTimersByTimeAsync(0)

    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    consoleError.mockRestore()
  })

  it('does not escalate when another navigation aborts the live recovery load', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, settleLoad, windowHandlers } =
      createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    // Chromium aborts the recovery load because something else replaced it — a user navigation, a close race,
    // another loadURL caller. The attempt token still says this reload is live, so nothing else filters it.
    settleLoad[1]?.reject(new Error(`ERR_ABORTED (-3) loading '${DOCUMENT_URL}'`))
    await vi.advanceTimersByTimeAsync(0)

    // A cold retry here would stomp the load that superseded this one.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    // The replacement load lands, and the window the user sees was never worth a Reload/Quit prompt. The crumb
    // says so: elapsedMs measures the replacement, and the budget analysis has to be able to leave it out.
    windowHandlers['did-finish-load']?.()
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'loaded', attempt: 1, superseded: true })
    )
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    windowHandlers['did-finish-load']?.()
    expect(onRecoveryReloadOutcome).toHaveBeenCalledTimes(1)

    consoleError.mockRestore()
  })

  it('still escalates on silence when an aborted recovery load has nothing behind it', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    settleLoad[1]?.reject(new Error('ERR_ABORTED (-3)'))
    await vi.advanceTimersByTimeAsync(0)

    // Ignoring the abort must not disarm the watchdog: the cap still bounds a load that goes nowhere.
    await vi.advanceTimersByTimeAsync(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'timeout', attempt: 1 })
    )
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'reload-stalled' })
    )

    consoleError.mockRestore()
  })

  it('gives the dev server a longer budget than a packaged load', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()
    isMock.dev = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/')

    try {
      createMainWindow(null, { onRecoveryReloadOutcome })
      crashRenderer()
      expect(browserWindowInstance.loadURL).toHaveBeenCalledTimes(2)

      vi.advanceTimersByTime(RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS - 1)
      expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'timeout', attempt: 1 })
      )
    } finally {
      vi.unstubAllEnvs()
      consoleError.mockRestore()
    }
  })

  it('stays silent when the stalled window is already closing', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, windowHandlers } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    windowHandlers.close?.({ preventDefault: vi.fn() } as never)
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)

    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    consoleError.mockRestore()
  })
  it('keeps the install path out of the outcome breadcrumb', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    crashRenderer()
    settleLoad[1]?.reject(new Error(INSTALL_PATH_LOAD_ERROR))
    await vi.advanceTimersByTimeAsync(0)

    const outcome = onRecoveryReloadOutcome.mock.calls[0]?.[0]
    expect(outcome).toEqual({
      status: 'failed',
      attempt: 1,
      elapsedMs: 0,
      progress: 'none',
      errorCode: 'ERR_FILE_NOT_FOUND'
    })
    // sanitizeCrashReportString cannot redact a file:///Users/... URL, so nothing path-shaped may reach the crumb.
    expect(JSON.stringify(outcome)).not.toContain('/')

    consoleError.mockRestore()
  })

  it('records a durable breadcrumb for a rejected load, since console output never reaches the bundle', async () => {
    const { consoleError, settleLoad } = createHarness()

    createMainWindow(null, {})
    settleLoad[0]?.reject(new Error(INSTALL_PATH_LOAD_ERROR))
    await vi.advanceTimersByTimeAsync(0)

    // Catching the rejection retired the main_unhandled_rejection crumb this used to produce.
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('main_window_load_failed', {
      errorCode: 'ERR_FILE_NOT_FOUND'
    })

    consoleError.mockRestore()
  })

  it('escalates to the prompt when both attempts are rejected outright', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    settleLoad[1]?.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    await vi.advanceTimersByTimeAsync(0)
    settleLoad[2]?.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    await vi.advanceTimersByTimeAsync(0)

    expect(onRecoveryReloadOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', attempt: 2, errorCode: 'ERR_CONNECTION_REFUSED' })
    )
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'reload-stalled', recentRecoveryCount: 1 })
    )

    consoleError.mockRestore()
  })

  it('hands the prompt a watched retry so a stalled manual reload re-raises it', () => {
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    // Reload is the dialog's default button; unwatched it returned the user to the same unbounded silent hang.
    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(5)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(2)

    consoleError.mockRestore()
  })

  it('names the crash-loop cause and gives that prompt a watched retry too', () => {
    const onRendererRecoveryExhausted = vi.fn()
    const { consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      crashRenderer()
    }

    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'crash-loop' })
    )
    expect(typeof onRendererRecoveryExhausted.mock.calls[0]?.[0].retry).toBe('function')

    consoleError.mockRestore()
  })

  it('restarts the stall budget when the machine resumes mid-load', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    crashRenderer()
    // Sleep freezes the timer; on wake it would otherwise fire against a load that never got its budget.
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS - 1)
    const resume = powerMonitorOnMock.mock.calls.find(([event]) => event === 'resume')?.[1] as (
      ...args: unknown[]
    ) => void
    resume()

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS - 1)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1)
    // Why the full span: rewriting the issue time on resume publishes time-since-wake into the bundle, which is
    // silently wrong on any laptop — the outcome crumb exists to be honest about how long the load actually ran.
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'timeout',
        attempt: 1,
        elapsedMs: RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2 - 1
      })
    )

    consoleError.mockRestore()
  })

  it('never restarts a load that reached a document, and gives it the rest of the cap', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, reachMilestone } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(10_000)
    reachMilestone('committed')

    // 'no did-finish-load yet' is not a stall: a cold restart here throws away a load that already committed, and
    // a machine that would have landed at ~60s misses the budget entirely.
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()

    reachMilestone('dom-ready')
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith({
      status: 'timeout',
      attempt: 1,
      elapsedMs: RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2,
      progress: 'dom-ready'
    })
    // Still never restarted, and the cap keeps the ~90s worst case the no-document path already had.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)

    consoleError.mockRestore()
  })

  it('records a reload that lands after the prompt, and leaves the recovered window alone', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)

    onRecoveryReloadOutcome.mockClear()
    vi.advanceTimersByTime(30_000)
    settleLoad[2]?.resolve()
    await vi.advanceTimersByTimeAsync(0)

    // Nothing cancels a pending Chromium load, so escalation must keep watching: a bundle that reads
    // `exhausted` for a recovery that actually worked misleads the next triage round.
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith({
      status: 'loaded',
      attempt: 2,
      elapsedMs: RENDERER_RECOVERY_LOAD_TIMEOUT_MS + 30_000,
      afterPrompt: true
    })

    // No API dismisses a native message box, so Reload is still aimed at a window that came back; taking it
    // would destroy the session the recovery just restored.
    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    consoleError.mockRestore()
  })

  it('separates the automatic recovery reload from the prompt-driven retry', () => {
    const onBeforeRecoveryReload = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onBeforeRecoveryReload, onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()

    // The field counts keyed on renderer_recovery_reload mean 'automatic recovery'; a manual retry recorded
    // under the same name silently redefines them.
    expect(onBeforeRecoveryReload.mock.calls.map(([, trigger]) => trigger)).toEqual([
      'automatic',
      'automatic',
      'manual-retry'
    ])

    consoleError.mockRestore()
  })

  it('keeps a shutdown-aborted load out of the crash breadcrumb stream', async () => {
    const { consoleError, settleLoad } = createHarness()

    createMainWindow(null, {})
    settleLoad[0]?.reject(new Error(`ERR_ABORTED (-3) loading '${DOCUMENT_URL}'`))
    await vi.advanceTimersByTimeAsync(0)

    // A quit or close aborts the in-flight startup load; a healthy shutdown must not look like a launch failure.
    expect(recordDurableCrashBreadcrumbMock).not.toHaveBeenCalledWith(
      'main_window_load_failed',
      expect.anything()
    )

    consoleError.mockRestore()
  })
})
