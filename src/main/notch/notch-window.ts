// The notch status window: a transparent, non-focusable panel pinned to the top of the
// primary display, sized to exactly the bar it paints.
import { BrowserWindow, screen, type Display, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { deferAppKitSceneMutation } from '../appkit-scene-mutation'
import { registerChromeWindow } from '../window/app-window-lookup'
import { installPrivilegedWindowNavigationPolicy } from '../window/privileged-window-navigation'
import { buildCollapsedBarLayout } from '../../shared/notch/notch-bar-geometry'
import {
  collapsedWindowRect,
  computeNotchPanelMetrics,
  expandedWindowRect,
  type NotchDisplayInfo,
  type NotchPanelMetrics
} from '../../shared/notch/notch-panel-rect'
import type { NotchStatusSummary } from '../../shared/notch/notch-status-summary'
import {
  NOTCH_SNAPSHOT_CHANNEL,
  toNotchSnapshot,
  type NotchRow
} from '../../shared/notch/notch-snapshot'
import { readScreenGeometry, type ScreenNotchGeometry } from './screen-geometry'

const NOTCH_PARTITION = 'orca-notch'

let notchWindow: BrowserWindow | null = null
let revision = 0

export function getNotchWindow(): BrowserWindow | null {
  return notchWindow && !notchWindow.isDestroyed() && !notchWindow.webContents.isDestroyed()
    ? notchWindow
    : null
}

export function isNotchRenderer(sender: WebContents): boolean {
  return getNotchWindow()?.webContents === sender
}

/** Merges Electron's display with the native helper's cutout reading. */
export function toNotchDisplayInfo(
  display: Display,
  geometry: ScreenNotchGeometry | undefined
): NotchDisplayInfo {
  const leading = geometry?.notchLeadingOffsetX
  const trailing = geometry?.notchTrailingOffsetX
  return {
    displayId: display.id,
    bounds: display.bounds,
    menuBarHeight: display.workArea.y - display.bounds.y,
    safeAreaTop: geometry?.safeAreaTop ?? null,
    // Helper offsets are screen-relative; Electron bounds are global.
    notchLeadingX: typeof leading === 'number' ? display.bounds.x + leading : null,
    notchTrailingX: typeof trailing === 'number' ? display.bounds.x + trailing : null
  }
}

export type NotchWindowOptions = {
  getSummary: () => NotchStatusSummary
  subscribe: (listener: (summary: NotchStatusSummary) => void) => () => void
  /** Resolves row labels from main's synchronous stores. */
  buildRows: (summary: NotchStatusSummary) => NotchRow[]
}

let expanded = false
let repaint: (() => void) | null = null
let detachListeners: (() => void) | null = null

/** Expansion lives in main because the window must already be the right size to paint into. */
export function setNotchExpanded(next: boolean): void {
  if (expanded === next) {
    return
  }
  expanded = next
  repaint?.()
}

export function isNotchExpanded(): boolean {
  return expanded
}

/**
 * Toggles whether the window swallows clicks.
 *
 * Why this is not optional: an Electron window captures every click inside its bounds, whether
 * or not the pixels there are transparent. The notch window spans the full panel width while
 * only the bar and card are painted, and it sits at NSStatusWindowLevel (25) — above
 * NSMainMenuWindowLevel (24). Left interactive, its transparent gutters silently eat clicks on
 * the system menu bar, invisibly. So the window ignores the mouse by default and only becomes
 * interactive while the pointer is genuinely over painted content; `forward: true` keeps move
 * events flowing to the renderer so it can still detect that.
 */
export function setNotchInteractive(interactive: boolean): void {
  const window = getNotchWindow()
  window?.setIgnoreMouseEvents(!interactive, { forward: true })
}

function loadNotchRenderer(window: BrowserWindow): void {
  // Mirrors the dashboard pop-out's dev/prod branch.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/notch.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/notch.html'))
  }
}

/**
 * Creates the notch window, or returns the existing one.
 * Returns null off macOS — the same shape as createSystemTray, so Windows and Linux carry no
 * dead window code and never evaluate display geometry.
 */
export function createNotchWindow(options: NotchWindowOptions): BrowserWindow | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const existing = getNotchWindow()
  if (existing) {
    return existing
  }

  const window = new BrowserWindow({
    // Real bounds land in the first reposition; start off-screen-safe and hidden.
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Non-focusable so clicking the bar never steals focus from the terminal behind it.
    focusable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    type: 'panel',
    // Why: without this macOS clamps the window to the work area — a request for y=0 comes
    // back as y=<menu bar height>, putting the bar below the notch instead of inside it.
    // This single option is what makes a notch-hugging surface possible in Electron at all.
    enableLargerThanScreen: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      partition: NOTCH_PARTITION,
      webviewTag: false
    }
  })

  notchWindow = window
  // Keeps the bar out of every "is the app window visible/focused?" lookup.
  registerChromeWindow(window)
  installPrivilegedWindowNavigationPolicy(window.webContents)
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)

  window.setAlwaysOnTop(true, 'status')
  // Why no `visibleOnFullScreen`: that option makes Electron demote the whole app to
  // NSApplicationActivationPolicyAccessory so a window can float over fullscreen apps — which
  // silently removes Orca from the Dock and from Cmd+Tab. Measured per-process: with the
  // option the app reports UIElement, without it Foreground, and every other window option
  // here is innocent. The bar therefore follows Spaces but not fullscreen apps, which is also
  // where macOS hides the menu bar it lives in.
  window.setVisibleOnAllWorkspaces(true)
  // Start inert: the renderer opts in per painted region. See setNotchInteractive.
  window.setIgnoreMouseEvents(true, { forward: true })

  let metrics: NotchPanelMetrics | null = null

  const reposition = (summary: NotchStatusSummary): void => {
    if (!metrics || window.isDestroyed()) {
      return
    }
    const layout = buildCollapsedBarLayout({
      summary,
      presentation: metrics.presentation,
      panelWidth: metrics.panelWidth,
      panelOriginX: metrics.panelOriginX,
      notchLeadingX: metrics.notchLeadingX,
      notchWidth: metrics.notchWidth
    })
    const rows = options.buildRows(summary)
    // Collapsing with no sessions left would otherwise leave an empty card hanging open.
    const isExpanded = expanded && rows.length > 0
    const rect = isExpanded
      ? expandedWindowRect(metrics, rows.length)
      : collapsedWindowRect(metrics, layout)
    revision += 1
    const snapshot = toNotchSnapshot(
      summary,
      layout,
      {
        presentation: metrics.presentation,
        topGap: metrics.topGap,
        barHeight: metrics.barHeight,
        notchWidth: metrics.notchWidth,
        cornerStyle: metrics.cornerStyle,
        topShoulderRadius: metrics.topShoulderRadius,
        bottomCornerRadius: metrics.bottomCornerRadius,
        expandedContentSideInset: metrics.expandedContentSideInset
      },
      rows,
      isExpanded,
      revision
    )

    deferAppKitSceneMutation(() => {
      if (window.isDestroyed()) {
        return
      }
      window.setBounds(rect)
      if (!window.isVisible()) {
        window.showInactive()
      }
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(NOTCH_SNAPSHOT_CHANNEL, snapshot)
      }
    })
  }

  const refreshGeometry = async (): Promise<void> => {
    const geometryByDisplayId = await readScreenGeometry()
    if (window.isDestroyed()) {
      return
    }
    // v1 pins the bar to the primary display; per-display panels are out of scope.
    const display = screen.getPrimaryDisplay()
    metrics = computeNotchPanelMetrics(
      toNotchDisplayInfo(display, geometryByDisplayId.get(display.id))
    )
    reposition(options.getSummary())
  }

  repaint = () => reposition(options.getSummary())

  const onDisplayChanged = (): void => {
    void refreshGeometry()
  }
  screen.on('display-metrics-changed', onDisplayChanged)
  screen.on('display-added', onDisplayChanged)
  screen.on('display-removed', onDisplayChanged)

  const unsubscribe = options.subscribe((summary) => reposition(summary))

  let detached = false
  const detach = (): void => {
    if (detached) {
      return
    }
    detached = true
    screen.removeListener('display-metrics-changed', onDisplayChanged)
    screen.removeListener('display-added', onDisplayChanged)
    screen.removeListener('display-removed', onDisplayChanged)
    unsubscribe()
  }
  detachListeners = detach

  window.on('closed', () => {
    detach()
    if (notchWindow === window) {
      notchWindow = null
      repaint = null
      expanded = false
      detachListeners = null
    }
  })

  window.webContents.once('did-finish-load', () => {
    void refreshGeometry()
  })
  loadNotchRenderer(window)
  return window
}

/**
 * Hides, then destroys.
 *
 * Why hide first: destroying a *visible* transparent panel kills the whole process — exit 0,
 * no stderr, no crash report.
 *
 * Why `immediate` exists: normally the destroy is deferred a turn, which is gentler on AppKit.
 * On the quit path it must happen in this same tick — Electron only emits `window-all-closed`
 * once the last window is really gone, and Orca uses that event to complete a Cmd+Q that its
 * renderer buffer-capture path deferred (see index.ts's window-all-closed handler). A window
 * still alive at that moment strands the app: no event, no re-triggered quit, no exit.
 */
function teardownNotchWindow(immediate: boolean): void {
  const window = notchWindow
  notchWindow = null
  repaint = null
  expanded = false
  // Why synchronously and not on 'closed': that fires after destroy, leaving the status
  // subscription live across the whole teardown gap and free to schedule another repaint.
  detachListeners?.()
  detachListeners = null
  if (!window || window.isDestroyed()) {
    return
  }
  if (window.isVisible()) {
    window.hide()
  }
  if (immediate) {
    window.destroy()
    return
  }
  deferAppKitSceneMutation(() => {
    if (window.isDestroyed()) {
      return
    }
    // Why hide again here: reposition's own deferred callback re-shows a hidden window, and
    // setTimeout is FIFO — one queued before this teardown runs first and makes the panel
    // visible again. Destroying a *visible* transparent panel kills the process outright
    // (exit 0, no stderr), so re-assert the hide immediately before destroying.
    if (window.isVisible()) {
      window.hide()
    }
    window.destroy()
  })
}

export function closeNotchWindow(): void {
  teardownNotchWindow(false)
}

/**
 * Why this is not merely tidiness: an always-on-top window that outlives the quit decision
 * suppresses `window-all-closed` entirely, so the app never exits and the bar stays on screen
 * with no owner. Tearing down synchronously here is what lets Orca quit at all.
 */
export function closeNotchWindowForQuit(): void {
  teardownNotchWindow(true)
}
