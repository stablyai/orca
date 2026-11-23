import type { WebContents } from 'electron'
import type { BrowserScreencastFrameMetadata } from '../../../../shared/browser/screencast/browser-screencast-protocol'
import { BrowserError } from '../../browser-error'
import {
  acquireElectronDebugger,
  type ElectronDebuggerLease
} from '../debugger/electron-debugger-lease'
import {
  browserScreencastDialogEvent,
  createBrowserScreencastPageEventHandler
} from './browser-screencast-cdp-events'
import {
  runDebuggerCommandWithTimeout,
  sendDebuggerCommand
} from './browser-screencast-debugger-command'
import { createBrowserScreencastDeviceMetrics } from './browser-screencast-device-metrics'
import {
  createBrowserScreencastLane,
  type BrowserScreencastLaneController
} from './browser-screencast-lane'
import { attachOrcaPageSession, releaseOrcaPageSession } from '../input/guest-frame-input-sessions'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'
import {
  answerBrowserJavaScriptDialog,
  getBrowserJavaScriptDialog,
  onBrowserJavaScriptDialogOpened
} from '../../guest-lifecycle/prompts/browser-javascript-dialogs'
import {
  clampScreencastViewportToGuestView,
  isEmbedderSizedScreencastGuest,
  readScreencastGuestViewSize,
  type BrowserScreencastGuestViewSize
} from './browser-screencast-guest-view-limit'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastLane,
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
  const stopRequested = new AbortController()
  // Each lane encodes the page at its own budget; the stream's own session serves one of them.
  const lanes = new Set<BrowserScreencastLaneController>()

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
    for (const lane of lanes) {
      lane.setViewport(next)
    }
    if (changed) {
      emulationGeneration += 1
    }
    return changed
  }

  const deviceMetrics = createBrowserScreencastDeviceMetrics(webContents, dbg, options)
  const readZoomFactor = (): number =>
    webContents.isDestroyed() || deviceMetrics.emulatesMobile() ? 1 : webContents.getZoomFactor()
  const applyDeviceMetricsOverride = (): Promise<void> => {
    const generation = emulationGeneration
    const applied = deviceMetrics.apply()
    // Advance even on failure so a rejected metrics write cannot suppress live frames forever.
    const markApplied = (): void => {
      appliedEmulationGeneration = Math.max(appliedEmulationGeneration, generation)
    }
    applied.then(markApplied, markApplied)
    return applied
  }
  const observeGuestViewSize = (metadata: BrowserScreencastFrameMetadata): boolean => {
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
  }
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    pendingUpdate = pendingUpdate.catch(() => {}).then(work)
    return pendingUpdate
  }

  const createLane = (
    cdpSessionId: string | undefined,
    budget: BrowserScreencastFrameBudget,
    onFrame: BrowserScreencastOptions['onFrame']
  ): BrowserScreencastLaneController => {
    const lane = createBrowserScreencastLane({
      webContents,
      dbg,
      cdpSessionId,
      options: { ...options, ...budget, onFrame },
      isStreamClosed: isClosed,
      isStreamStopping: isStopping,
      streamStopSignal: stopRequested.signal,
      enqueue,
      readZoomFactor,
      applyDeviceMetricsOverride,
      observeGuestViewSize,
      onStopped: () => {
        lanes.delete(lane)
        if (cdpSessionId !== undefined) {
          releaseOrcaPageSession(webContents, cdpSessionId)
        }
      }
    })
    lanes.add(lane)
    return lane
  }
  const rootLaneIsFree = (): boolean =>
    !Array.from(lanes).some((lane) => lane.cdpSessionId === undefined)
  const openLane = async (
    budget: BrowserScreencastFrameBudget,
    onFrame: BrowserScreencastOptions['onFrame']
  ): Promise<BrowserScreencastLane> => {
    let lane: BrowserScreencastLaneController | null = null
    await enqueue(async () => {
      if (closed || stopping) {
        throw new BrowserError('browser_error', 'Browser stream ended.')
      }
      const cdpSessionId = rootLaneIsFree()
        ? undefined
        : await attachOrcaPageSession(webContents, (method, params, sessionId) =>
            runDebuggerCommandWithTimeout(method, () =>
              sendGuestCdpCommand(webContents, method, params, sessionId)
            )
          )
      if (cdpSessionId !== undefined && (closed || stopping)) {
        // Stop already ended the lanes it knew of; this session would outlive the stream.
        await runDebuggerCommandWithTimeout('Target.detachFromTarget', () =>
          dbg.sendCommand('Target.detachFromTarget', { sessionId: cdpSessionId })
        ).catch(() => {})
        releaseOrcaPageSession(webContents, cdpSessionId)
        throw new BrowserError('browser_error', 'Browser stream ended.')
      }
      const opened = createLane(cdpSessionId, budget, onFrame)
      lane = opened
      try {
        await opened.start()
      } catch (error) {
        opened.handle.stop()
        throw error
      }
    })
    return lane!.handle
  }

  const reemulate = (): Promise<void> =>
    enqueue(async () => {
      if (closed || stopping) {
        return
      }
      await Promise.all(Array.from(lanes, (lane) => lane.reemulate()))
    })

  const firstLane = createLane(undefined, options, options.onFrame)
  const handlePageEvent = createBrowserScreencastPageEventHandler({
    options,
    isClosed,
    isStopping,
    scheduleNavigationFrameCapture: () => {
      for (const lane of lanes) {
        lane.scheduleNavigationFrameCapture()
      }
    },
    openDialog: () => getBrowserJavaScriptDialog(webContents.id)
  })
  const handleMessage = (
    _event: unknown,
    method: string,
    params: unknown,
    sessionId?: string
  ): void => {
    if (method === 'Page.screencastFrame') {
      // Electron reports the stream's own session as an empty id.
      const laneSessionId = sessionId || undefined
      for (const lane of lanes) {
        if (lane.cdpSessionId === laneSessionId) {
          lane.handleFrame(params)
          return
        }
      }
      return
    }
    if (!sessionId) {
      handlePageEvent(method, params)
    }
  }

  const finish = (): void => {
    if (closed) {
      return
    }
    closed = true
    for (const lane of Array.from(lanes)) {
      lane.close()
    }
    dbg.removeListener('message', handleMessage as never)
    dbg.removeListener('detach', handleDetach as never)
    stopWatchingDialogs()
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
  // The owner names the asking frame and turns away a second frame's dialog before viewers see it.
  const stopWatchingDialogs = onBrowserJavaScriptDialogOpened(webContents.id, (dialog) => {
    if (!isClosed() && !isStopping()) {
      options.onEvent?.(browserScreencastDialogEvent(dialog))
    }
  })
  dbg.on('detach', handleDetach as never)

  try {
    await sendDebuggerCommand(dbg, 'Page.enable')
    await deviceMetrics.apply()
    await firstLane.start()
    // Hidden embedders may stop compositing without producing a frame.
    const noFrameTimer = setTimeout(() => {
      if (!closed && !stopping && ![firstLane, ...lanes].some((lane) => lane.getSeq() > 0)) {
        options.onError?.(options.noFrameMessage?.() ?? 'Browser stream timed out.')
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
    firstLane: firstLane.handle,
    openLane,
    stop: () => {
      if (closed || stopping) {
        return
      }
      stopping = true
      stopRequested.abort()
      for (const lane of Array.from(lanes)) {
        lane.handle.stop()
      }
      void enqueue(async () => {
        // Dismiss before releasing this CDP session; a replacement may block while the dialog is open.
        answerBrowserJavaScriptDialog(webContents.id, { accept: false, promptText: '' })
        if (deviceMetrics.isOverridden()) {
          await deviceMetrics.clear().catch(() => {})
        }
      }).finally(finish)
    },
    done
  }
}
