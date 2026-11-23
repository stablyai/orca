import { app, BrowserWindow, screen, type Display, type WebContents } from 'electron'
import { join } from 'node:path'
import { deferAppKitSceneMutation } from '../window/desktop-integration/appkit-scene-mutation'
import { isBackgroundLaunch } from '../window/activation/foreground-activation-policy'
import { registerChromeWindow } from '../window/app-window-lookup'
import { installPrivilegedWindowNavigationPolicy } from '../window/security/privileged-window-navigation'
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

import { configureNotchWindowVisibility } from './notch-window-visibility'

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

export function publishNotchSnapshot(): void {
  repaint?.()
}

export function isNotchExpanded(): boolean {
  return expanded
}

export function setNotchInteractive(interactive: boolean): void {
  const window = getNotchWindow()
  window?.setIgnoreMouseEvents(!interactive, { forward: true })
}

function loadNotchRenderer(window: BrowserWindow): void {
  // Mirrors the dashboard pop-out's dev/prod branch.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/notch.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/notch.html'))
  }
}

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
  window.setVisibleOnAllWorkspaces(true)
  configureNotchWindowVisibility(window)
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
    if (rows.length === 0) {
      expanded = false
    }
    const isExpanded = expanded
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
      if (window.isDestroyed() || notchWindow !== window) {
        return
      }
      window.setBounds(rect)
      if (!isBackgroundLaunch() && !window.isVisible()) {
        window.showInactive()
      }
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(NOTCH_SNAPSHOT_CHANNEL, snapshot)
      }
    })
  }

  let geometryRefreshRunning = false
  let geometryRefreshPending = false
  const refreshGeometry = async (): Promise<void> => {
    geometryRefreshPending = true
    if (geometryRefreshRunning) {
      return
    }
    geometryRefreshRunning = true
    try {
      do {
        geometryRefreshPending = false
        const geometryByDisplayId = await readScreenGeometry()
        if (window.isDestroyed() || notchWindow !== window) {
          return
        }
        // A display event during sampling invalidates that read, even if it shared a helper.
        if (geometryRefreshPending) {
          continue
        }
        const display = screen.getPrimaryDisplay()
        metrics = computeNotchPanelMetrics(
          toNotchDisplayInfo(display, geometryByDisplayId.get(display.id))
        )
        reposition(options.getSummary())
      } while (geometryRefreshPending)
    } finally {
      geometryRefreshRunning = false
    }
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

function teardownNotchWindow(immediate: boolean): void {
  const window = notchWindow
  notchWindow = null
  repaint = null
  expanded = false
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
    if (window.isVisible()) {
      window.hide()
    }
    window.destroy()
  })
}

export function closeNotchWindow(): void {
  teardownNotchWindow(false)
}

export function closeNotchWindowForQuit(): void {
  teardownNotchWindow(true)
}
