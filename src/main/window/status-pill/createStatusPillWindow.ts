import { BrowserWindow, screen, type Display, type Rectangle } from 'electron'
import { join } from 'node:path'
import {
  computeStatusPillPlacement,
  computeStatusPillPlacementForPoint,
  getCursorScreenPointSafe,
  pickDisplayForCursor
} from './placement'
import { StatusPillBroadcaster, type StatusPillBroadcasterOptions } from './status-pill-broadcaster'
import { computeStatusPillAgentRows, computeStatusPillSummary } from './status-pill-summary'
import { attachStatusPillIpcListeners } from './status-pill-ipc'
import {
  attachDisplayListeners,
  defaultStatusPillWarn,
  loadPillEntry
} from './status-pill-window-helpers'
import type {
  StatusPillAgentRow,
  StatusPillAnswerResult,
  StatusPillPreferences,
  StatusPillSummary
} from '../../../shared/status-pill-preload-api'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'

/** Minimal surface we use from OrcaRuntimeService. Keeps the pill decoupled
 *  from the full runtime type so tests can substitute a stub. */
export type StatusPillRuntime = {
  getAgentStatusTerminalHandleForPaneKey: (paneKey: string) => string | undefined
  sendTerminal: (
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    options?: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      reserveWrite?: (ptyId: string) => void
      afterWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
    }
  ) => Promise<unknown>
}

/** Pill body dimensions in CSS pixels. Wide enough for "claude — fix-auth-bug ·
 *  Writing middleware.ts" + usage chips, matching a Dynamic-Island-style notch
 *  bar (Vibe Island) rather than a tiny capsule. */
const PILL_WIDTH = 560
const PILL_HEIGHT = 40

/** Window padding around the capsule so the box-shadow halo has room to render
 *  outside the .pill body. Without this the shadow + the expanded panel get
 *  clipped by the BrowserWindow bounds (the original 320x32 window truncated
 *  both). Mirrored in the renderer (PILL_RENDERER_PADDING_*). */
const PILL_PADDING_X = 18
const PILL_PADDING_TOP = 6
const PILL_PADDING_BOTTOM = 34

/** Initial window dimensions (resting state). Width matches the capsule +
 *  horizontal padding; height is capsule + top + bottom padding so the
 *  downward shadow renders fully and the window can grow for the panel. */
const PILL_WINDOW_WIDTH = PILL_WIDTH + PILL_PADDING_X * 2
const PILL_WINDOW_HEIGHT = PILL_HEIGHT + PILL_PADDING_TOP + PILL_PADDING_BOTTOM

export {
  PILL_WIDTH,
  PILL_HEIGHT,
  PILL_PADDING_X,
  PILL_PADDING_TOP,
  PILL_PADDING_BOTTOM,
  PILL_WINDOW_WIDTH,
  PILL_WINDOW_HEIGHT
}

export type CreateStatusPillWindowOptions = {
  /** Pulls the current full agent-status snapshot. Used by the broadcaster
   *  and the initial pull channel. */
  getSnapshot: () => AgentStatusIpcPayload[]
  /** Focus the Orca main window (reopening it if needed). Called when the user
   *  clicks the pill body. */
  onFocusMainWindow: () => void
  /** Focus a specific agent pane in the main window. Called when the user
   *  clicks a row in the expanded panel. */
  onFocusPane: (target: { paneKey: string; worktreeId?: string | null }) => void
  /** Runtime, used to resolve paneKey → terminal handle and to write the
   *  answer bytes when the user answers a pending question from the pill. */
  runtime?: StatusPillRuntime
  /** Read the user's last dragged pill position (screen coords), or null when
   *  the pill has never been dragged. Drives restore + re-clamp on display
   *  changes so the pill stays where the user put it. */
  getPersistedPosition?: () => { x: number; y: number } | null
  /** Persist a new pill position after the user drags it. The factory debounces
   *  writes from the drag stream. */
  persistPosition?: (position: { x: number; y: number }) => void
  /** Disable the pill (context-menu "Hide pill"). Coordinator wires this to
   *  flipping the setting off. */
  onHidePill: () => void
  /** Optional logger; defaults to console.warn. */
  warn?: (message: string, error?: unknown) => void
  /** Scheduler overrides for tests. */
  broadcasterOptions?: Pick<StatusPillBroadcasterOptions, 'now' | 'scheduler' | 'clearScheduler'>
}

export type StatusPillWindowHandle = {
  /** The underlying BrowserWindow. Caller must guard with `isDestroyed()`. */
  window: BrowserWindow
  /** Re-anchor the pill on display-metrics / display-added / display-removed. */
  refreshPlacement: () => void
  /** Push a new summary to the pill renderer (coalesced by the broadcaster). */
  broadcastSnapshot: () => void
  /** Tear down the window and its broadcaster. Idempotent. */
  destroy: () => void
}

/** Construct the floating, non-activating pill BrowserWindow + its broadcaster
 *  and wire display-metric + IPC listeners. Returns a handle whose `destroy()`
 *  must be called on setting toggle-off / app shutdown. */
export function createStatusPillWindow(
  options: CreateStatusPillWindowOptions
): StatusPillWindowHandle | null {
  const warn = options.warn ?? defaultStatusPillWarn
  const getEntries = (): AgentStatusIpcPayload[] => options.getSnapshot()
  const getSummary = (): StatusPillSummary => computeStatusPillSummary(getEntries())
  const getRows = (): StatusPillAgentRow[] => computeStatusPillAgentRows(getEntries())

  let window: BrowserWindow
  try {
    window = new BrowserWindow({
      width: PILL_WINDOW_WIDTH,
      height: PILL_WINDOW_HEIGHT,
      frame: false,
      // Why: allow programmatic resize via setBounds when the expanded panel
      // outgrows the resting window. Disables only user-driven resize.
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      // Why: transparent keeps the pill visually floating on all platforms.
      // Some Linux Wayland compositors lack alpha support; we recover at
      // runtime via the backgroundColor round-trip below.
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      // Why: macOS-specific keys keep the pill out of Mission Control and the
      // app switcher, and let the renderer draw its own capsule shape.
      hiddenInMissionControl: process.platform === 'darwin',
      roundedCorners: false,
      // Why: 'panel' on macOS floats above full-screen apps without activating
      // the app; on Linux/Windows the value is undefined so they fall back to
      // a normal top-level window.
      type: process.platform === 'darwin' ? 'panel' : undefined,
      show: false,
      focusable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/status-pill.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
  } catch (error) {
    warn('[status-pill] failed to create BrowserWindow', error)
    return null
  }

  // Why: setVisibleOnAllWorkspaces is the cross-version-safe way to anchor
  // the pill on every macOS Space and Linux workspace. The constructor option
  // form is typed inconsistently across Electron minors.
  try {
    window.setVisibleOnAllWorkspaces(true, {
      // Why: skipTransformAccessibility on macOS, visibleOnFullScreen where
      // supported. Falling back gracefully on Linux Wayland where the flag is
      // only a hint.
      skipTransformProcessType: true
    })
  } catch {
    // Best-effort; some platforms reject the options bag.
    try {
      window.setVisibleOnAllWorkspaces(true)
    } catch {
      // Headless / test environment.
    }
  }

  // Why: try to confirm the transparent background actually took; if the
  // compositor rejected it the renderer will draw an opaque capsule fallback.
  try {
    window.setBackgroundColor('#00000000')
  } catch {
    // Best-effort; some Linux compositors reject this and Electron throws.
  }

  // Why: default to click-through so the transparent padding around the
  // capsule passes mouse events to the apps behind the overlay. The renderer
  // toggles this off via statusPill:setInteractive when the cursor enters the
  // capsule/panel (interactive regions). forward:true keeps mouseMove events
  // flowing so the renderer can detect mouseenter on its own elements.
  try {
    window.setIgnoreMouseEvents(true, { forward: true })
  } catch {
    try {
      window.setIgnoreMouseEvents(true)
    } catch {
      // Best-effort; older Electron versions or headless/test environments.
    }
  }

  // Why: 'screen-saver' level on Windows is the only one that clears the
  // taskbar z-order. 'floating' (the default) leaves the pill under the
  // taskbar on Win10/11.
  if (process.platform === 'win32') {
    try {
      window.setAlwaysOnTop(true, 'screen-saver')
    } catch {
      // Older Electron versions may not accept the level argument.
    }
  }

  const initialPlacement = computePlacementForActiveDisplay(warn, options.getPersistedPosition?.())
  if (initialPlacement) {
    try {
      window.setBounds(initialPlacement, false)
    } catch (error) {
      warn('[status-pill] failed to set initial bounds', error)
    }
  }

  // Why: debounce position writes so a fluid drag (many setPosition calls) only
  // hits the store once after the user stops moving. 400ms mirrors the main
  // window's bounds-save debounce.
  let persistTimer: NodeJS.Timeout | null = null
  const persistPositionDebounced = (position: { x: number; y: number }): void => {
    if (!options.persistPosition) {
      return
    }
    if (persistTimer) {
      clearTimeout(persistTimer)
    }
    persistTimer = setTimeout(() => {
      persistTimer = null
      try {
        options.persistPosition?.(position)
      } catch (error) {
        warn('[status-pill] failed to persist position', error)
      }
    }, 400)
  }

  const broadcaster = new StatusPillBroadcaster({
    getSnapshot: options.getSnapshot,
    send: (payload) => {
      if (window.isDestroyed()) {
        return
      }
      try {
        // Why: push summary + rows together so the renderer's resting pill
        // and its expanded panel never disagree, even though only the resting
        // pill paints by default.
        window.webContents.send('statusPill:snapshot', payload.summary)
        window.webContents.send('statusPill:agentRows', payload.rows)
      } catch {
        // Swallow: webContents mid-teardown.
      }
    },
    ...options.broadcasterOptions
  })

  const detachDisplayListeners = attachDisplayListeners(refreshPlacement)
  const detachIpc = attachStatusPillIpcListeners({
    window,
    onFocusMainWindow: options.onFocusMainWindow,
    onFocusPane: options.onFocusPane,
    getSummary,
    getRows,
    runtime: options.runtime,
    onHidePill: options.onHidePill,
    warn,
    // Why: the renderer drives manual dragging (mousedown → mousemove). It
    // reads the window's screen origin on pointer down and pushes the new
    // origin on each move; main persists the final position (debounced).
    getWindowPosition: () => {
      try {
        const [x, y] = window.getPosition()
        return { x, y }
      } catch {
        return { x: 0, y: 0 }
      }
    },
    setWindowPosition: (position) => {
      if (window.isDestroyed()) {
        return
      }
      try {
        window.setPosition(Math.round(position.x), Math.round(position.y), false)
        persistPositionDebounced(position)
      } catch (error) {
        warn('[status-pill] failed to set window position', error)
      }
    }
  })

  // Why: push the initial snapshot as soon as the renderer signals it is
  // ready, so the pill never paints an empty state for 250 ms on first mount.
  window.once('ready-to-show', () => {
    try {
      broadcaster.flushNow()
      // Why: showInactive so the pill never steals focus from the editor or
      // the Orca main window when it appears.
      window.showInactive()
    } catch (error) {
      warn('[status-pill] failed initial show', error)
    }
  })

  // Why: load the dedicated pill entry. Dev uses the electron-vite URL; prod
  // uses the packaged HTML file.
  loadPillEntry(window, warn).catch((error) => {
    warn('[status-pill] failed to load pill entry', error)
  })

  function refreshPlacement(): void {
    if (window.isDestroyed()) {
      return
    }
    // Why: re-read the persisted position so a display-metrics / display-added
    // event re-clamps the pill in place instead of teleporting it back to the
    // cursor's display (the pre-drag behavior).
    const next = computePlacementForActiveDisplay(warn, options.getPersistedPosition?.())
    if (!next) {
      return
    }
    try {
      window.setBounds(next, false)
    } catch (error) {
      warn('[status-pill] failed to apply refreshed bounds', error)
    }
  }

  function destroy(): void {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    detachDisplayListeners()
    detachIpc()
    broadcaster.destroy()
    if (!window.isDestroyed()) {
      window.destroy()
    }
  }

  return {
    window,
    refreshPlacement,
    broadcastSnapshot: () => broadcaster.scheduleBroadcast(),
    destroy
  }

  function computePlacementForActiveDisplay(
    warnFn: (m: string, e?: unknown) => void,
    persisted?: { x: number; y: number } | null
  ): Rectangle | null {
    let displays: Display[] = []
    try {
      displays = screen.getAllDisplays()
    } catch (error) {
      warnFn('[status-pill] screen.getAllDisplays failed', error)
      return null
    }
    if (displays.length === 0) {
      return null
    }
    // Why: when the user has dragged the pill, keep it where they put it. The
    // pinned-point helper re-clamps into the display that contains the point
    // (falling back to the primary when that monitor is gone) so the pill can
    // never land off-screen.
    if (persisted) {
      return computeStatusPillPlacementForPoint({
        displays,
        point: persisted,
        pillWidth: PILL_WIDTH,
        pillHeight: PILL_HEIGHT
      })
    }
    const cursor = getCursorScreenPointSafe(screen)
    const display = pickDisplayForCursor(displays, cursor)
    if (!display) {
      return null
    }
    return computeStatusPillPlacement({
      pillWidth: PILL_WIDTH,
      pillHeight: PILL_HEIGHT,
      display,
      platform: process.platform
    })
  }
}

// Re-exported so the main index can keep a single import line for the
// status-pill subsystem.
export { StatusPillBroadcaster }
export type { StatusPillAgentRow, StatusPillAnswerResult, StatusPillPreferences, StatusPillSummary }
