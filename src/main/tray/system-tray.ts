import { Menu, Tray } from 'electron'
import { createAppIconImage } from '../app-icon'
import { translateMain } from '../i18n/main-i18n'

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

// Why: on Windows the notification area expects a 16px icon; the app icon PNG
// is larger, so downscale to avoid a cropped/blurry tray glyph.
const TRAY_ICON_SIZE = 16

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
  const image = createAppIconImage(opts.appIcon).resize({
    width: TRAY_ICON_SIZE,
    height: TRAY_ICON_SIZE
  })
  tray = new Tray(image)
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

/** Destroys the tray icon if present. Safe to call repeatedly or with no tray. */
export function destroySystemTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
}
