import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  markSystemSessionEnding,
  resetExpectedTeardownStateForTest
} from '../crash-reporting/expected-teardown-state'
import type { MainWindowLoadObserver } from './main-window-contracts'
import { RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS } from './renderer-bootstrap-liveness'
import {
  createRendererRecoveryReloadWatchdog,
  RENDERER_RECOVERY_LOAD_TIMEOUT_MS
} from './renderer-recovery-reload-watchdog'

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

function createHarness(
  args: {
    isRecoveryPending?: () => boolean
    isWindowClosing?: () => boolean
    isDestroyed?: () => boolean
    getIsQuitting?: () => boolean
  } = {}
) {
  const webContents = Object.assign(new EventEmitter(), { id: 143 })
  const mainWindow = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  if (args.isDestroyed) {
    mainWindow.isDestroyed = args.isDestroyed
  }
  const loads: MainWindowLoadObserver[] = []
  const onRecoveryReloadOutcome = vi.fn()
  const onRendererRecoveryExhausted = vi.fn()
  const watchdog = createRendererRecoveryReloadWatchdog({
    mainWindow,
    rendererWebContentsId: webContents.id,
    isRecoveryPending: args.isRecoveryPending ?? (() => false),
    isWindowClosing: args.isWindowClosing ?? (() => false),
    reloadMainWindow: (observer) => loads.push(observer),
    opts: {
      onRecoveryReloadOutcome,
      onRendererRecoveryExhausted,
      ...(args.getIsQuitting ? { getIsQuitting: args.getIsQuitting } : {})
    }
  })
  const abortLatestLoad = () => loads.at(-1)?.onError?.(new Error('ERR_ABORTED (-3)'))
  watchdog.issue({ reason: 'crashed', exitCode: 5 }, 1)
  return {
    watchdog,
    webContents,
    loads,
    abortLatestLoad,
    onRecoveryReloadOutcome,
    onRendererRecoveryExhausted
  }
}

describe('superseding recovery navigations', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetExpectedTeardownStateForTest()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetExpectedTeardownStateForTest()
  })

  it('removes listeners and the pending stall timer during teardown', () => {
    const { watchdog, webContents, loads, onRecoveryReloadOutcome } = createHarness()
    expect(webContents.eventNames().sort()).toEqual(['did-fail-load', 'did-navigate', 'dom-ready'])
    expect(vi.getTimerCount()).toBe(1)
    watchdog.clear()
    expect(webContents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    loads[0]?.onLoaded?.()
    loads[0]?.onError?.(new Error('ERR_FILE_NOT_FOUND'))
    watchdog.notifySystemResume()
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not mistake a replacement error page for recovery', () => {
    const {
      watchdog,
      webContents,
      abortLatestLoad,
      onRecoveryReloadOutcome,
      onRendererRecoveryExhausted
    } = createHarness()
    abortLatestLoad()
    webContents.emit('did-navigate')
    webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing', true)
    watchdog.notifyDocumentLoaded()

    expect(onRecoveryReloadOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'loaded' })
    )
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'ERR_FILE_NOT_FOUND' })
    )
    watchdog.clear()
  })

  it('ignores subframe failures and aborted replacement navigations', () => {
    const { watchdog, webContents, abortLatestLoad, onRecoveryReloadOutcome } = createHarness()
    abortLatestLoad()
    webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing', false)
    webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///previous', true)
    watchdog.notifyDocumentLoaded()
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'loaded', superseded: true })
    )
    watchdog.clear()
  })

  it('keeps Reload available if the replacement fails beneath an existing prompt', () => {
    const {
      watchdog,
      webContents,
      loads,
      abortLatestLoad,
      onRecoveryReloadOutcome,
      onRendererRecoveryExhausted
    } = createHarness()
    abortLatestLoad()
    webContents.emit('did-navigate')
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing', true)
    watchdog.notifyDocumentLoaded()
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'loaded' })
    )
    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    expect(loads).toHaveLength(2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    watchdog.clear()
  })

  it('gives a blank document its own first attempt, not the stalled reload it inherits state from', () => {
    let recoveryPending = false
    const { watchdog, loads, onRecoveryReloadOutcome, onRendererRecoveryExhausted } = createHarness(
      {
        isRecoveryPending: () => recoveryPending
      }
    )
    // Attempt 1 stalls and retries; attempt 2 then times out while a renderer death owns the next load.
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(loads).toHaveLength(2)
    recoveryPending = true
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(loads).toHaveLength(2)

    // That queued recovery declined to reload, and the document still up never runs its JavaScript.
    recoveryPending = false
    watchdog.notifyDocumentLoaded()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)
    expect(loads).toHaveLength(3)

    // Attempt 1, so this reload still has its retry: the stalled attempt's number is not its own.
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(onRecoveryReloadOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'timeout', attempt: 1 })
    )
    expect(loads).toHaveLength(4)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
    watchdog.clear()
  })

  // A blank document is not a reason to touch a window the user or the OS is already tearing down:
  // the reload would race teardown, and after the box is gone there is nothing to recover into.
  it.each([
    { state: 'the window is closing', overrides: { isWindowClosing: () => true }, blanks: 0 },
    { state: 'the app is quitting', overrides: { getIsQuitting: () => true }, blanks: 0 },
    { state: 'the window is destroyed', overrides: { isDestroyed: () => true }, blanks: 0 },
    { state: 'the OS is ending the session', sessionEnding: true, blanks: 0 },
    { state: 'nothing is shutting down', blanks: 1 }
  ])('reloads a blank document only while the session is alive: $state', (scenario) => {
    if (scenario.sessionEnding) {
      markSystemSessionEnding()
    }
    const { watchdog, loads, onRecoveryReloadOutcome } = createHarness(scenario.overrides ?? {})
    // The crash reload landed, so nothing else owns the next load — but its document never booted.
    loads[0]?.onLoaded?.()
    watchdog.notifyDocumentLoaded()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)

    expect(loads).toHaveLength(1 + scenario.blanks)
    expect(
      onRecoveryReloadOutcome.mock.calls.filter(([outcome]) => outcome.status === 'blank')
    ).toHaveLength(scenario.blanks)
    watchdog.clear()
  })

  // The gate's one retry belongs to the blank document that gets reloaded. Spending it on one the
  // watchdog refused to act on sends the next genuine blank straight to the prompt.
  it('does not spend the single blank-window retry on a suppressed document', () => {
    let recoveryPending = true
    const { watchdog, loads, onRendererRecoveryExhausted } = createHarness({
      isRecoveryPending: () => recoveryPending
    })
    loads[0]?.onLoaded?.()
    // A queued crash recovery owns the next load, so this blank document is left alone.
    watchdog.notifyDocumentLoaded()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)
    expect(loads).toHaveLength(1)

    recoveryPending = false
    watchdog.notifyDocumentLoaded()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS)

    expect(loads).toHaveLength(2)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
    watchdog.clear()
  })

  // powerMonitor 'resume' reaches the watchdog; the bootstrap deadline suspends with everything
  // else, so on wake it is already expired against a renderer whose confirmation is merely queued.
  it('gives a suspended boot its full confirmation budget again on resume', () => {
    const { watchdog, loads } = createHarness()
    loads[0]?.onLoaded?.()
    watchdog.notifyDocumentLoaded()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS - 1)
    watchdog.notifySystemResume()

    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS - 1)
    expect(loads).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(loads).toHaveLength(2)
    watchdog.clear()
  })

  // A confirmed boot owes nothing, so resume must not arm a deadline nobody is waiting on.
  it('arms nothing on resume when no document owes a confirmation', () => {
    const { watchdog, loads } = createHarness()
    loads[0]?.onLoaded?.()
    watchdog.notifySystemResume()
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS * 2)
    expect(loads).toHaveLength(1)
    watchdog.clear()
  })

  it('drops the bootstrap deadline when the window tears down', () => {
    const { watchdog, loads, onRecoveryReloadOutcome } = createHarness()
    loads[0]?.onLoaded?.()
    watchdog.notifyDocumentLoaded()
    expect(vi.getTimerCount()).toBe(1)

    watchdog.clear()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS * 2)
    expect(loads).toHaveLength(1)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'blank' })
    )
  })

  it('recognizes a successful replacement started after the stall prompt', () => {
    const {
      watchdog,
      loads,
      abortLatestLoad,
      onRecoveryReloadOutcome,
      onRendererRecoveryExhausted
    } = createHarness()
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    abortLatestLoad()
    watchdog.notifyDocumentLoaded()
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'loaded', superseded: true, afterPrompt: true })
    )
    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    expect(loads).toHaveLength(2)
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    watchdog.clear()
  })
})
