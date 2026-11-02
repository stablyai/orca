import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'
import { createBrowserScreencastMessageHandler } from './browser-screencast-cdp-events'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import { createBrowserScreencastDeviceMetrics } from './browser-screencast-device-metrics'
import { createBrowserScreencastFramePacer } from './browser-screencast-frame-pacer'
import { createBrowserScreencastSnapshotCapture } from './browser-screencast-snapshot-capture'
import {
  answerBrowserJavaScriptDialog,
  getBrowserJavaScriptDialog
} from './browser-javascript-dialogs'
import {
  clampScreencastViewportToGuestView,
  isEmbedderSizedScreencastGuest,
  readScreencastGuestViewSize,
  type BrowserScreencastGuestViewSize
} from './browser-screencast-guest-view-limit'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastOptions,
  BrowserScreencastSession,
  BrowserScreencastViewport
} from './browser-screencast-stream-types'

const NO_FRAME_TIMEOUT_MS = 10_000

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

  // Preserve the client request so the viewport can grow back after the guest view limit shrinks it.
  const embedderSizedGuest = isEmbedderSizedScreencastGuest(webContents)
  let requestedViewport: BrowserScreencastViewport = {
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
    deviceScaleFactor: options.deviceScaleFactor,
    mobile: options.mobile
  }
  let guestViewSize: BrowserScreencastGuestViewSize | null = null
  let emulationGeneration = 0
  let appliedEmulationGeneration = 0
  const applyEffectiveViewport = (): boolean => {
    const next = clampScreencastViewportToGuestView(requestedViewport, guestViewSize)
    const changed =
      next.viewportWidth !== options.viewportWidth || next.viewportHeight !== options.viewportHeight
    Object.assign(options, next)
    if (changed) {
      emulationGeneration += 1
    }
    return changed
  }

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
    applyDeviceMetricsOverride: () => {
      const generation = emulationGeneration
      const applied = deviceMetrics.apply()
      // Advance even on failure so a rejected metrics write cannot suppress live frames forever.
      const markApplied = (): void => {
        appliedEmulationGeneration = Math.max(appliedEmulationGeneration, generation)
      }
      applied.then(markApplied, markApplied)
      return applied
    }
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
    bumpSnapshotGeneration: snapshotCapture.bumpGeneration,
    observeGuestViewSize: (metadata) => {
      if (!embedderSizedGuest) {
        return false
      }
      const size = readScreencastGuestViewSize(metadata)
      if (size && (guestViewSize?.width !== size.width || guestViewSize.height !== size.height)) {
        guestViewSize = size
        if (applyEffectiveViewport()) {
          void reemulate().catch(() => {})
        }
      }
      // Reject old-layout crops until queued viewport metrics have landed.
      return appliedEmulationGeneration < emulationGeneration
    },
    openDialog: () => getBrowserJavaScriptDialog(webContents.id)
  })

  const reemulate = (): Promise<void> => {
    pendingUpdate = pendingUpdate
      .catch(() => {})
      .then(async () => {
        if (closed || stopping) {
          return
        }
        snapshotCapture.bumpGeneration()
        snapshotCapture.clearNavigationCaptureTimer()
        framePacer.clearPending(true)
        // initialOnly would skip metrics updates once this stream has emitted a frame.
        await snapshotCapture.emitSnapshotFrame(false)
      })
    return pendingUpdate
  }

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
    // Close before notifying owners that may call stop in response.
    finish()
    options.onError?.('Browser debugger detached while streaming.')
  }

  dbg.on('message', handleMessage as never)
  dbg.on('detach', handleDetach as never)

  try {
    await sendDebuggerCommand(dbg, 'Page.enable')
    await deviceMetrics.apply()
    await startScreencast()
    pendingUpdate = snapshotCapture.emitSnapshotFrame(true)
    // Hidden embedders may stop compositing without producing a frame.
    const noFrameTimer = setTimeout(() => {
      if (!closed && !stopping && framePacer.getSeq() === 0) {
        options.onError?.('Browser stream timed out.')
      }
    }, NO_FRAME_TIMEOUT_MS)
    void done.then(() => clearTimeout(noFrameTimer))
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
      if (!closed && !stopping) {
        requestedViewport = { ...viewport }
        applyEffectiveViewport()
      }
      return reemulate()
    },
    updateFrameBudget: (budget: BrowserScreencastFrameBudget) => {
      pendingUpdate = pendingUpdate
        .catch(() => {})
        .then(async () => {
          if (closed || stopping) {
            return
          }
          Object.assign(options, budget)
          // Chromium needs a restart for frame caps; the pacer reads its interval live.
          await startScreencast()
        })
      return pendingUpdate
    },
    stop: () => {
      if (closed || stopping) {
        return
      }
      stopping = true
      snapshotCapture.bumpGeneration()
      snapshotCapture.clearNavigationCaptureTimer()
      framePacer.clearPending(true)
      try {
        void (async () => {
          await pendingUpdate.catch(() => {})
          // Dismiss before releasing this CDP session; a replacement may block while the dialog is open.
          answerBrowserJavaScriptDialog(webContents.id, { accept: false, promptText: '' })
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
