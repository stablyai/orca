import { app, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { WindowRect } from './window-bounds-validation'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

/**
 * Window plumbing shared by every popout-style window (dashboard pop-out,
 * detachable pane windows): sizing floor, restored-bounds validation,
 * security wiring, debounced bounds persistence, deferred show, and the
 * popout.html dev/prod loader. Window-specific behavior (zoom, singleton
 * tracking, pane lifecycle) stays with each caller.
 */

export const POPOUT_MIN_WIDTH = 480
export const POPOUT_MIN_HEIGHT = 360
export const POPOUT_DEFAULT_WIDTH = 960
export const POPOUT_DEFAULT_HEIGHT = 720

const BOUNDS_SAVE_DEBOUNCE_MS = 500

/** Validate persisted popout bounds; discard off-screen or near-minimum rects. */
export function resolveRestoredPopoutBounds(
  raw: WindowRect | null,
  logTag: string
): WindowRect | null {
  if (
    raw &&
    raw.width >= POPOUT_MIN_WIDTH &&
    raw.height >= POPOUT_MIN_HEIGHT &&
    rectHasVisibleAreaOnAnyDisplay(raw, POPOUT_MIN_WIDTH / 2, POPOUT_MIN_HEIGHT / 2)
  ) {
    return raw
  }
  if (raw) {
    console.warn(`[${logTag}] Discarding off-screen/near-min popout bounds:`, raw)
  }
  return null
}

// Why: popouts use isolated sessions, which do not inherit the main session's
// deny-by-default permission policy — it must be re-applied per window.
export function installPopoutWindowSecurity(webContents: WebContents): void {
  installPrivilegedWindowNavigationPolicy(webContents)
  webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  webContents.session.setPermissionCheckHandler(() => false)
}

/**
 * Debounced bounds persistence, frozen during close/quit so teardown-time
 * resize/move events can't clobber the remembered size with near-minimum
 * bounds.
 */
let appQuitting = false
let beforeQuitRegistered = false

function registerGlobalBeforeQuitListener(): void {
  if (beforeQuitRegistered) {
    return
  }
  beforeQuitRegistered = true
  app.on('before-quit', () => {
    appQuitting = true
  })
}

export function installPopoutBoundsPersistence(
  window: BrowserWindow,
  saveRect: (rect: WindowRect) => void
): void {
  registerGlobalBeforeQuitListener()
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  let windowClosing = false
  const saveBounds = (): void => {
    if (boundsTimer) {
      clearTimeout(boundsTimer)
    }
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (
        windowClosing ||
        appQuitting ||
        window.isDestroyed() ||
        window.isMinimized() ||
        window.isFullScreen()
      ) {
        return
      }
      const bounds = window.getBounds()
      if (bounds.width < POPOUT_MIN_WIDTH || bounds.height < POPOUT_MIN_HEIGHT) {
        return
      }
      saveRect(bounds)
    }, BOUNDS_SAVE_DEBOUNCE_MS)
  }
  window.on('resize', saveBounds)
  window.on('move', saveBounds)

  const freezeBounds = (): void => {
    windowClosing = true
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
  }

  const unfreezeBounds = (): void => {
    // If the close event was prevented, allow bounds persistence again
    windowClosing = false
  }

  window.on('close', (e) => {
    freezeBounds()
    // Wait until next tick to check if close was prevented by e.preventDefault()
    process.nextTick(() => {
      if (!window.isDestroyed() && !e.defaultPrevented) {
        // Not prevented or already destroyed, do nothing
      } else if (!window.isDestroyed() && e.defaultPrevented) {
        unfreezeBounds()
      }
    })
  })
}

// Why: popouts are created with show:false to avoid a white flash before load.
export function showPopoutWhenReady(window: BrowserWindow): void {
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
    }
  })
}

/** Load popout.html with the given query string — dev server in dev, emitted file in prod. */
export function loadPopoutHtml(window: BrowserWindow, search: string): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/popout.html?${search}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/popout.html'), { search })
  }
}
