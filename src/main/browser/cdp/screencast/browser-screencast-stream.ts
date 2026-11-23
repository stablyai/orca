import type { WebContents } from 'electron'
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
import {
  attachOrcaPageSession,
  detachOrcaPageSession,
  releaseOrcaPageSession
} from '../input/guest-frame-input-sessions'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'
import {
  answerBrowserJavaScriptDialog,
  getBrowserJavaScriptDialog,
  onBrowserJavaScriptDialogOpened
} from '../../guest-lifecycle/prompts/browser-javascript-dialogs'
import { createBrowserScreencastEmulatedViewport } from './browser-screencast-emulated-viewport'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastLane,
  BrowserScreencastLaneViewers,
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

  const deviceMetrics = createBrowserScreencastDeviceMetrics(webContents, dbg, options)
  const readZoomFactor = (): number =>
    webContents.isDestroyed() || deviceMetrics.emulatesMobile() ? 1 : webContents.getZoomFactor()
  const viewport = createBrowserScreencastEmulatedViewport({
    webContents,
    options,
    deviceMetrics,
    onViewport: (next) => {
      for (const lane of lanes) {
        lane.setViewport(next)
      }
    },
    reemulate: () => reemulate()
  })
  let pendingCapture = Promise.resolve()
  const runExclusiveCapture = (capture: () => Promise<void>): Promise<void> => {
    pendingCapture = pendingCapture.catch(() => {}).then(capture)
    return pendingCapture
  }
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    pendingUpdate = pendingUpdate.catch(() => {}).then(work)
    return pendingUpdate
  }

  const createLane = (
    cdpSessionId: string | undefined,
    budget: BrowserScreencastFrameBudget,
    viewers: BrowserScreencastLaneViewers
  ): BrowserScreencastLaneController => {
    const lane = createBrowserScreencastLane({
      webContents,
      dbg,
      cdpSessionId,
      options: { ...options, ...budget, ...viewers },
      isStreamClosed: isClosed,
      isStreamStopping: isStopping,
      streamStopSignal: stopRequested.signal,
      enqueue,
      readZoomFactor,
      applyDeviceMetricsOverride: viewport.applyDeviceMetricsOverride,
      runExclusiveCapture,
      observeGuestViewSize: viewport.observeGuestViewSize,
      sendPageCommand,
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
  const sendPageCommand = (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> =>
    runDebuggerCommandWithTimeout(method, () =>
      sendGuestCdpCommand(webContents, method, params, sessionId)
    )
  const rootLaneIsFree = (): boolean =>
    !Array.from(lanes).some((lane) => lane.cdpSessionId === undefined)
  const openLane = async (
    budget: BrowserScreencastFrameBudget,
    viewers: BrowserScreencastLaneViewers
  ): Promise<BrowserScreencastLane> => {
    let lane: BrowserScreencastLaneController | null = null
    await enqueue(async () => {
      if (closed || stopping) {
        throw new BrowserError('browser_error', 'Browser stream ended.')
      }
      const cdpSessionId = rootLaneIsFree()
        ? undefined
        : await attachOrcaPageSession(webContents, (method, params, sessionId) =>
            sendGuestCdpCommand(webContents, method, params, sessionId)
          )
      if (cdpSessionId !== undefined && (closed || stopping)) {
        // Stop already ended the lanes it knew of; this session would outlive the stream.
        await detachOrcaPageSession(webContents, sendPageCommand, cdpSessionId)
        throw new BrowserError('browser_error', 'Browser stream ended.')
      }
      const opened = createLane(cdpSessionId, budget, viewers)
      lane = opened
      try {
        await opened.start()
      } catch (error) {
        opened.handle.stop()
        throw error
      }
      // A stop during start already queued this lane's teardown.
      if (closed || stopping) {
        throw new BrowserError('browser_error', 'Browser stream ended.')
      }
    })
    return lane!.handle
  }

  const reemulate = (): Promise<void> =>
    enqueue(async () => {
      if (closed || stopping) {
        return
      }
      // The first capture writes the new metrics; the other lanes' frames follow without holding the update.
      const [first, ...rest] = Array.from(lanes)
      const firstFrame = first?.reemulate()
      for (const lane of rest) {
        void lane.reemulate().catch(() => {})
      }
      await firstFrame
    })

  const firstLane = createLane(undefined, options, {
    onFrame: options.onFrame,
    isViewerBacklogged: options.isViewerBacklogged
  })
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
    updateViewport: (requested: BrowserScreencastViewport) => {
      if (!closed && !stopping) {
        viewport.request(requested)
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
