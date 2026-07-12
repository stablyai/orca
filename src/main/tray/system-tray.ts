import { Menu, Tray, type NativeImage } from 'electron'
import { createAppIconImage } from '../app-icon'
import { translateMain } from '../i18n/main-i18n'
import { composeTrayAttentionIcon } from './tray-attention-icon'

type SystemTrayOptions = {
  /** App icon id from settings; the tray reuses the app icon image. */
  appIcon: unknown
  /** Restore + show + focus the main window (recreating it if needed). */
  onOpen: () => void
  /** Quit Orca for real (caller must set the quitting latch before quitting). */
  onQuit: () => void
}

// Why: Electron's Tray is GC-collected and its icon vanishes if no live
// reference is kept, so hold it at module scope for the app's lifetime.
let tray: Tray | null = null

// Why: hold the plain (dot-free) icon so we can toggle the attention dot on and
// off with tray.setImage without rebuilding the icon from the app-icon PNG.
let baseTrayImage: NativeImage | null = null

// Why: an attention event can fire while the tray is still being created
// (creation is deferred ~ready-to-show); remember the desired state so a
// freshly created tray reflects it immediately.
let attentionActive = false

// Why: on Windows the notification area expects a 16px icon; the app icon PNG
// is larger, so downscale to avoid a cropped/blurry tray glyph.
const TRAY_ICON_SIZE = 16

// Why: centralize which image the tray shows so both creation and attention
// toggling stay in sync. No-ops safely when the tray or base image is missing.
function applyTrayImage(): void {
  if (!tray || tray.isDestroyed() || !baseTrayImage) {
    return
  }
  tray.setImage(attentionActive ? composeTrayAttentionIcon(baseTrayImage) : baseTrayImage)
}

/**
 * Creates the Windows system tray icon. No-op on macOS/Linux. Idempotent: a
 * second call while a tray is alive returns the existing one instead of
 * stacking a duplicate ghost icon.
 */
export function createSystemTray(opts: SystemTrayOptions): Tray | null {
  if (process.platform !== 'win32') {
    return null
  }
  if (tray && !tray.isDestroyed()) {
    return tray
  }
  baseTrayImage = createAppIconImage(opts.appIcon).resize({
    width: TRAY_ICON_SIZE,
    height: TRAY_ICON_SIZE
  })
  tray = new Tray(baseTrayImage)
  // Why: reflect any attention event that fired before the tray existed.
  applyTrayImage()
  tray.setToolTip('Orca')
  const menu = Menu.buildFromTemplate([
    { label: translateMain('tray.openOrca', 'Open Orca'), click: () => opts.onOpen() },
    { type: 'separator' },
    { label: translateMain('tray.quit', 'Quit'), click: () => opts.onQuit() }
  ])
  tray.setContextMenu(menu)
  // Why: a left-click on the tray icon is the conventional Windows gesture to
  // restore a minimized-to-tray app.
  tray.on('click', () => opts.onOpen())
  return tray
}

/**
 * Shows or hides a red/amber attention dot on the tray icon. Call with `true`
 * when a terminal bell or agent completion fires while the window is
 * minimized/hidden, and `false` once the window is shown again. No-op on
 * macOS/Linux (no tray) and safe to call before the tray is created.
 */
export function setTrayAttention(active: boolean): void {
  if (attentionActive === active) {
    return
  }
  attentionActive = active
  applyTrayImage()
}

/** Destroys the tray icon if present. Safe to call repeatedly or with no tray. */
export function destroySystemTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
  baseTrayImage = null
  attentionActive = false
}
