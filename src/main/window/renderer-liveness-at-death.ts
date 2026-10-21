import type { BrowserWindow } from 'electron'
import { recordCoalescedDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

/**
 * What the main window looked like to the user when its renderer died.
 *
 * Why: Windows `killed`/exit 1 reports are identical whether Task Manager, an EDR or
 * Orca held the knife. A renderer that had been hung for minutes, or a document
 * that never loaded (the post-update blank frame), turns "outside kill" into "the
 * user ended a frozen Orca" — and that is an Orca bug to chase, not noise.
 */
export type RendererLivenessAtDeath = {
  /** Set only while Chromium flags the renderer hung (needs ~15s of unacknowledged input); absent = not detected hung. */
  rendererUnresponsiveForMs?: number
  /** False when the current document never finished loading, or its load failed (blank window). */
  rendererDocumentLoaded: boolean
  /** Present when the current main-frame load failed; Electron still fires did-finish-load after it. */
  rendererDocumentLoadFailed?: true
  /** Age of the current document, so "never loaded" reads as seconds or minutes. */
  rendererDocumentAgeMs: number
  /** Absent when the window was already destroyed. */
  mainWindowState?: 'visible' | 'minimized' | 'hidden'
  mainWindowFocused?: boolean
}

// Why no dispose: every listener lives on the window or its webContents and dies with them.
export type RendererLivenessTracker = {
  /** Reads the state at a renderer death and clears the hang, so the replacement renderer's
   * `responsive` is not logged as the dead one recovering. */
  takeAtRendererGone: () => RendererLivenessAtDeath
}

// Why coalesced: a renderer that flaps hung/responsive must not evict the 30-slot ring.
const UNRESPONSIVE_CRUMB_MIN_INTERVAL_MS = 60_000

export function trackRendererLivenessAtDeath(
  window: BrowserWindow,
  now: () => number = Date.now
): RendererLivenessTracker {
  const contents = window.webContents
  let unresponsiveSince: number | null = null
  let documentLoaded = false
  let documentLoadFailed = false
  let documentStartedAt = now()

  const onUnresponsive = (): void => {
    unresponsiveSince ??= now()
    recordCoalescedDurableCrashBreadcrumb({
      name: 'renderer_unresponsive',
      coalesceKey: 'main-window-renderer-unresponsive',
      minIntervalMs: UNRESPONSIVE_CRUMB_MIN_INTERVAL_MS
    })
  }
  const onResponsive = (): void => {
    if (unresponsiveSince === null) {
      return
    }
    const hungForMs = now() - unresponsiveSince
    unresponsiveSince = null
    recordCoalescedDurableCrashBreadcrumb({
      name: 'renderer_responsive',
      data: { hungForMs },
      coalesceKey: 'main-window-renderer-responsive',
      minIntervalMs: UNRESPONSIVE_CRUMB_MIN_INTERVAL_MS
    })
  }
  // Why start, not did-navigate: a failed load never commits, so did-navigate would leave the
  // previous document's state in place for the blank window this exists to catch.
  const onNavigationStart = (details?: {
    isMainFrame?: boolean
    isSameDocument?: boolean
  }): void => {
    // Why optional: a throwing listener would stop the emitter's later navigation listeners.
    if (!details?.isMainFrame || details.isSameDocument) {
      return
    }
    unresponsiveSince = null
    documentLoaded = false
    documentLoadFailed = false
    documentStartedAt = now()
  }
  const onLoadFailed = (
    _event: unknown,
    errorCode: number,
    _description: string,
    _url: string,
    isMainFrame: boolean
  ): void => {
    // -3 (ERR_ABORTED) is a superseded navigation, not a failed document.
    if (isMainFrame && errorCode !== -3) {
      documentLoadFailed = true
    }
  }
  const onLoaded = (): void => {
    documentLoaded = !documentLoadFailed
  }
  window.on('unresponsive', onUnresponsive)
  window.on('responsive', onResponsive)
  contents.on('did-start-navigation', onNavigationStart)
  contents.on('did-fail-load', onLoadFailed)
  contents.on('did-finish-load', onLoaded)

  return {
    takeAtRendererGone: () => {
      const at = now()
      const state: RendererLivenessAtDeath = {
        ...(unresponsiveSince === null
          ? {}
          : { rendererUnresponsiveForMs: at - unresponsiveSince }),
        rendererDocumentLoaded: documentLoaded,
        ...(documentLoadFailed ? { rendererDocumentLoadFailed: true } : {}),
        rendererDocumentAgeMs: at - documentStartedAt,
        ...readWindowState(window)
      }
      unresponsiveSince = null
      return state
    }
  }
}

function readWindowState(
  window: BrowserWindow
): Pick<RendererLivenessAtDeath, 'mainWindowState' | 'mainWindowFocused'> {
  // Why never throw: this runs inside render-process-gone ahead of recovery
  // scheduling, and a window dying mid-close throws on every getter.
  try {
    if (window.isDestroyed()) {
      return {}
    }
    return {
      mainWindowState: window.isMinimized()
        ? 'minimized'
        : window.isVisible()
          ? 'visible'
          : 'hidden',
      mainWindowFocused: window.isFocused()
    }
  } catch {
    return {}
  }
}
