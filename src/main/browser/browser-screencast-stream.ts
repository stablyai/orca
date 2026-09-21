import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'
import { createBrowserScreencastMessageHandler } from './browser-screencast-cdp-events'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import { createBrowserScreencastDeviceMetrics } from './browser-screencast-device-metrics'
import { createBrowserScreencastFramePacer } from './browser-screencast-frame-pacer'
import { createBrowserScreencastSnapshotCapture } from './browser-screencast-snapshot-capture'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastOptions,
  BrowserScreencastSession,
  BrowserScreencastViewport
} from './browser-screencast-stream-types'

export async function startBrowserScreencast(
  webContents: WebContents,
  options: BrowserScreencastOptions
): Promise<BrowserScreencastSession> {
  if (webContents.isDestroyed()) {
    throw new BrowserError('browser_tab_not_found', 'Browser tab is no longer available')
  }

  const dbg = webContents.debugger
  let debuggerLease: ElectronDebuggerLease | null = null
  try {
    debuggerLease = acquireElectronDebugger(webContents)
  } catch {
    throw new BrowserError(
      'browser_error',
      'Could not attach debugger. DevTools may already be open for this tab.'
    )
  }

  let closed = false
  let stopping = false
  let resolveDone!: () => void
  // Serializes viewport and frame-budget changes against the snapshot capture they trigger.
  let pendingUpdate = Promise.resolve()
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const isClosed = (): boolean => closed
  const isStopping = (): boolean => stopping

  const deviceMetrics = createBrowserScreencastDeviceMetrics(webContents, dbg, options)
  const framePacer = createBrowserScreencastFramePacer({ dbg, options, isClosed, isStopping })
  const snapshotCapture = createBrowserScreencastSnapshotCapture({
    webContents,
    dbg,
    options,
    isClosed,
    isStopping,
    getSeq: framePacer.getSeq,
    queueFrame: framePacer.queueFrame,
    applyDeviceMetricsOverride: deviceMetrics.apply
  })
  const handleMessage = createBrowserScreencastMessageHandler({
    dbg,
    options,
    isClosed,
    isStopping,
    queueFrame: framePacer.queueFrame,
    ackScreencastFrame: framePacer.ackFrame,
    scheduleNavigationFrameCapture: snapshotCapture.scheduleNavigationFrameCapture,
    clearNavigationCaptureTimer: snapshotCapture.clearNavigationCaptureTimer,
    bumpSnapshotGeneration: snapshotCapture.bumpGeneration
  })

  const startScreencast = (): Promise<unknown> =>
    sendDebuggerCommand(dbg, 'Page.startScreencast', {
      format: options.format,
      quality: options.quality,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      everyNthFrame: options.everyNthFrame
    })

  const finish = (): void => {
    if (closed) {
      return
    }
    closed = true
    snapshotCapture.clearNavigationCaptureTimer()
    framePacer.clearPending()
    dbg.removeListener('message', handleMessage as never)
    dbg.removeListener('detach', handleDetach as never)
    debuggerLease?.release()
    debuggerLease = null
    resolveDone()
  }

  const handleDetach = (): void => {
    options.onError?.('Browser debugger detached while streaming.')
    finish()
  }

  dbg.on('message', handleMessage as never)
  dbg.on('detach', handleDetach as never)

  try {
    await sendDebuggerCommand(dbg, 'Page.enable')
    await deviceMetrics.apply()
    await startScreencast()
    pendingUpdate = snapshotCapture.emitSnapshotFrame(true)
  } catch (error) {
    if (deviceMetrics.isOverridden()) {
      await deviceMetrics.clear().catch(() => {})
    }
    finish()
    throw new BrowserError(
      'browser_error',
      error instanceof Error ? error.message : 'Failed to start browser screencast.'
    )
  }

  return {
    updateViewport: (viewport: BrowserScreencastViewport) => {
      pendingUpdate = pendingUpdate
        .catch(() => {})
        .then(async () => {
          if (closed || stopping) {
            return
          }
          Object.assign(options, viewport)
          snapshotCapture.bumpGeneration()
          snapshotCapture.clearNavigationCaptureTimer()
          framePacer.clearPending(true)
          // Why: initialOnly skips every stream that ever emitted a frame, which would
          // leave the old device metrics applied and the new subscriber frameless.
          await snapshotCapture.emitSnapshotFrame(false)
        })
      return pendingUpdate
    },
    updateFrameBudget: (budget: BrowserScreencastFrameBudget) => {
      pendingUpdate = pendingUpdate
        .catch(() => {})
        .then(async () => {
          if (closed || stopping) {
            return
          }
          Object.assign(options, budget)
          // Why: the pacer reads minFrameIntervalMs live off options, but Chromium only
          // picks up new frame caps when the screencast is restarted with them.
          await startScreencast()
        })
      return pendingUpdate
    },
    stop: () => {
      if (closed) {
        return
      }
      stopping = true
      snapshotCapture.bumpGeneration()
      snapshotCapture.clearNavigationCaptureTimer()
      framePacer.clearPending(true)
      try {
        void (async () => {
          await pendingUpdate.catch(() => {})
          await sendDebuggerCommand(dbg, 'Page.stopScreencast').catch(() => {})
          if (deviceMetrics.isOverridden()) {
            await deviceMetrics.clear().catch(() => {})
          }
        })().finally(finish)
      } catch {
        finish()
      }
    },
    done
  }
}
