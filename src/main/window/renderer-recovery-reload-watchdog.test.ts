import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainWindowLoadObserver } from './main-window-contracts'
import {
  createRendererRecoveryReloadWatchdog,
  RENDERER_RECOVERY_LOAD_TIMEOUT_MS
} from './renderer-recovery-reload-watchdog'

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

function createHarness() {
  const webContents = Object.assign(new EventEmitter(), { id: 143 })
  const mainWindow = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
  const loads: MainWindowLoadObserver[] = []
  const onRecoveryReloadOutcome = vi.fn()
  const onRendererRecoveryExhausted = vi.fn()
  const watchdog = createRendererRecoveryReloadWatchdog({
    mainWindow,
    rendererWebContentsId: webContents.id,
    isRecoveryPending: () => false,
    isWindowClosing: () => false,
    reloadMainWindow: (observer) => loads.push(observer),
    opts: { onRecoveryReloadOutcome, onRendererRecoveryExhausted }
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
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

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
