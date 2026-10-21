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
vi.mock('../browser/browser-client-page-renderer-runtime', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    attachBrowserClientPageRenderer: harness.attachClientPageRendererMock,
    retireBrowserClientPageRenderer: harness.retireClientPageRendererMock
  }
})

import { createMainWindow } from './createMainWindow'
import type { CreateMainWindowOptions } from './main-window-contracts'
import { shouldRecoverRendererAfterProcessGone } from '../crash-reporting/process-gone-classification'
import {
  browserWindowMock,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'
import { RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS } from './renderer-launch-failure-backoff'

// macOS LAUNCH_RESULT_FAILURE: posix_spawn of the Renderer helper failed (field: EAGAIN, per-user process limit).
const LAUNCH_FAILED: Electron.RenderProcessGoneDetails = { reason: 'launch-failed', exitCode: 1003 }
const CRASHED: Electron.RenderProcessGoneDetails = { reason: 'crashed', exitCode: 5 }

/**
 * Field shape (v1.4.218, bundle F0C6NHQF4C8): while the OS refuses spawns, every load emits launch-failed and then
 * rejects ERR_FAILED within ~10ms, before any did-finish-load. Once headroom returns the same webContents loads.
 */
function createSpawnRefusingWindow(platform: NodeJS.Platform = 'darwin') {
  const handlers: Record<string, (...args: any[]) => void> = {}
  const spawn = { refused: true }
  const webContents = {
    id: 143,
    getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers[event] = handler
    }),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn()
  }
  const load = vi.fn((): Promise<void> => {
    if (!spawn.refused) {
      queueMicrotask(() => handlers['did-finish-load']?.())
      return Promise.resolve()
    }
    queueMicrotask(() =>
      withPlatform(platform, () => handlers['render-process-gone']?.({}, LAUNCH_FAILED))
    )
    return Promise.reject(
      new Error("ERR_FAILED (-2) loading 'file:///opt/orca/renderer/index.html'")
    )
  })
  browserWindowMock.mockImplementation(function () {
    return {
      webContents,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: load,
      loadURL: load
    }
  })
  return { handlers, load, spawn }
}

function open(overrides: CreateMainWindowOptions = {}) {
  const onRendererRecoveryExhausted = vi.fn()
  const onRecoveryReloadOutcome = vi.fn()
  createMainWindow(null, {
    onRendererRecoveryExhausted,
    onRecoveryReloadOutcome,
    shouldRecoverRenderer: (details) =>
      shouldRecoverRendererAfterProcessGone({ reason: details.reason, expectedTeardown: 'none' }),
    ...overrides
  })
  return { onRendererRecoveryExhausted, onRecoveryReloadOutcome }
}

const BACKOFF_TOTAL_MS = RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)

describe('renderer launch-failed recovery', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('backs off instead of opening the crash-loop breaker after 3 quick failures', async () => {
    const { load } = createSpawnRefusingWindow()
    const { onRendererRecoveryExhausted } = open()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)

    // Field: 3 reloads in ~750ms, then the breaker opened. Now retries spread out: 250ms, 1s, 2s, 4s, ...
    await vi.advanceTimersByTimeAsync(250)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(load).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(load).toHaveBeenCalledTimes(5)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('recovers in place once spawn headroom returns, without any prompt', async () => {
    const { handlers, load, spawn } = createSpawnRefusingWindow()
    const { onRendererRecoveryExhausted, onRecoveryReloadOutcome } = open()
    // Field: the process table stayed full for minutes.
    await vi.advanceTimersByTimeAsync(250 + 1_000 + 2_000 + 4_000 + 8_000 + 15_000)
    expect(load).toHaveBeenCalledTimes(7)
    spawn.refused = false

    await vi.advanceTimersByTimeAsync(30_000)
    expect(load).toHaveBeenCalledTimes(8)
    expect(onRecoveryReloadOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'loaded' })
    )
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(load).toHaveBeenCalledTimes(8)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    // A loaded document starts a fresh schedule: the next launch failure retries after 250ms again.
    spawn.refused = true
    handlers['render-process-gone']?.({}, LAUNCH_FAILED)
    await vi.advanceTimersByTimeAsync(250)
    expect(load).toHaveBeenCalledTimes(9)
  })

  it('prompts only after the ~2 minute schedule is spent, then a failed manual retry re-prompts', async () => {
    const { load } = createSpawnRefusingWindow()
    const { onRendererRecoveryExhausted } = open()
    await vi.advanceTimersByTimeAsync(BACKOFF_TOTAL_MS - 1)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    // The last retry fails too; its prompt follows on the usual 250ms recovery tick.
    await vi.advanceTimersByTimeAsync(251)
    expect(BACKOFF_TOTAL_MS).toBeLessThanOrEqual(125_000)
    expect(load).toHaveBeenCalledTimes(1 + RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS.length)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({
        details: LAUNCH_FAILED,
        cause: 'launch-failed',
        recentRecoveryCount: RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS.length
      })
    )

    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    expect(load).toHaveBeenCalledTimes(2 + RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS.length)
    await vi.advanceTimersByTimeAsync(250)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(load).toHaveBeenCalledTimes(2 + RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS.length)
  })

  it('stops recovery when quitting during the long backoff', async () => {
    const { load } = createSpawnRefusingWindow()
    let quitting = false
    const { onRendererRecoveryExhausted } = open({ getIsQuitting: () => quitting })
    await vi.advanceTimersByTimeAsync(250 + 1_000 + 2_000 + 4_000)
    const loadsBeforeQuit = load.mock.calls.length
    quitting = true
    await vi.advanceTimersByTimeAsync(BACKOFF_TOTAL_MS * 2)
    expect(load).toHaveBeenCalledTimes(loadsBeforeQuit)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('does not spend retry attempts on duplicate failure events', async () => {
    const { handlers, load } = createSpawnRefusingWindow()
    const { onRendererRecoveryExhausted } = open()
    await vi.advanceTimersByTimeAsync(0)
    handlers['render-process-gone']?.({}, LAUNCH_FAILED)
    handlers['render-process-gone']?.({}, LAUNCH_FAILED)
    await vi.advanceTimersByTimeAsync(250)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(load).toHaveBeenCalledTimes(2)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('keeps Windows launch failures on the short recovery schedule', async () => {
    const { load } = createSpawnRefusingWindow('win32')
    const { onRendererRecoveryExhausted } = open()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(load).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'launch-failed', recentRecoveryCount: 3 })
    )
  })

  it('keeps the crash-loop breaker for renderers that actually crash', async () => {
    const { handlers, load, spawn } = createSpawnRefusingWindow()
    spawn.refused = false
    const { onRendererRecoveryExhausted } = open()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 4; i += 1) {
      handlers['render-process-gone']?.({}, CRASHED)
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(load).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ details: CRASHED, cause: 'crash-loop', recentRecoveryCount: 3 })
    )
  })
})
