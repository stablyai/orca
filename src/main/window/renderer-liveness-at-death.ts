import type { BrowserWindow } from 'electron'
import { recordCoalescedDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

/** Windows killed/exit1 cannot identify Task Manager, EDR or Orca as the cause. Retain prior hang/load state to distinguish users terminating a frozen app from unexplained external kills. */
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

// Window/WebContents listeners die with their owners; no separate disposal.
export type RendererLivenessTracker = {
  /** Snapshot death and clear hung state so replacement responsiveness is not attributed to the dead renderer. */
  takeAtRendererGone: () => RendererLivenessAtDeath
}

// Coalesce hang flapping so it cannot evict the 30-entry breadcrumb ring.
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
  // Reset at navigation start: failed loads never commit and would otherwise inherit the previous document's healthy state.
  const onNavigationStart = (details?: {
    isMainFrame?: boolean
    isSameDocument?: boolean
  }): void => {
    // Malformed details must not throw and suppress later emitter listeners.
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
  // This runs before recovery scheduling; destroyed-window getters must not throw and prevent recovery.
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
