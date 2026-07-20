import { Menu, Tray, nativeImage, nativeTheme, type NativeImage } from 'electron'
import menuBarIconPath from '../../../resources/tray/orca-menu-barTemplate.png?asset&asarUnpack'
import menuBarIconRetinaPath from '../../../resources/tray/orca-menu-barTemplate@2x.png?asset&asarUnpack'
import { createAppIconImage } from '../app-icon'
import { translateMain } from '../i18n/main-i18n'
import { composeTrayAttentionIcon, tintTrayTemplateForAttention } from './tray-attention-icon'
import { stampTrayDevBadge } from './tray-dev-badge'

export type SystemTrayOptions = {
  /** App icon id from settings; the tray reuses the app icon image. */
  appIcon: unknown
  /** True for dev/unpackaged instances; shows a DEV marker on the tray. */
  isDevInstance: boolean
  /** Worktree/branch label identifying the dev instance, when known. */
  devInstanceLabel: string | null
  /** Restore + show + focus the main window (recreating it if needed). */
  onOpen: () => void
  /** Restore the main window and open its Settings surface. */
  onOpenSettings: () => void
  /** Run the existing user-initiated update check. */
  onCheckForUpdates: () => void
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

// Why: dev instances share the production template glyph, so remember dev-ness
// at module scope; tooltip rebuilds (attention on/off) must keep the marker.
let devIndicator: { label: string | null } | null = null

let nativeThemeUpdatedListener: (() => void) | null = null

// Why: multiple dev instances can run side by side (one per worktree); the
// tooltip carries the worktree/branch label so hovering tells them apart.
function baseTooltip(): string {
  if (!devIndicator) {
    return 'Orca'
  }
  return devIndicator.label ? `Orca DEV (${devIndicator.label})` : 'Orca DEV'
}

// Why: on Windows the notification area expects a 16px icon; the app icon PNG
// is larger, so downscale to avoid a cropped/blurry tray glyph.
const TRAY_ICON_SIZE = 16

// Why: centralize which image the tray shows so both creation and attention
// toggling stay in sync. No-ops safely when the tray or base image is missing.
function applyTrayImage(): void {
  if (!tray || tray.isDestroyed() || !baseTrayImage) {
    return
  }

  if (process.platform === 'darwin') {
    if (attentionActive) {
      try {
        // Why: disabling template tinting makes the amber dot possible, but the
        // glyph then needs literal pixels chosen for the current menu-bar theme.
        const useLightGlyph = nativeTheme.shouldUseDarkColors
        const attentionImage = composeTrayAttentionIcon(
          tintTrayTemplateForAttention(baseTrayImage, useLightGlyph)
        )
        if (baseTrayImage.getScaleFactors().includes(2)) {
          // Why: toBitmap reads only the 1x pixels, so rebuild the @2x
          // representation or the glyph blurs on Retina during attention.
          const retinaAttentionImage = composeTrayAttentionIcon(
            tintTrayTemplateForAttention(baseTrayImage, useLightGlyph, 2)
          )
          attentionImage.addRepresentation({
            scaleFactor: 2,
            dataURL: retinaAttentionImage.toDataURL()
          })
        }
        attentionImage.setTemplateImage(false)
        tray.setImage(attentionImage)
        tray.setToolTip(
          devIndicator
            ? `${baseTooltip()} - ${translateMain('tray.activityWaitingSuffix', 'activity waiting')}`
            : translateMain('tray.activityWaiting', 'Orca - activity waiting')
        )
        return
      } catch (error) {
        // Why: this path runs inside unguarded callbacks (nativeTheme 'updated',
        // the notification bell), so a NativeImage failure must degrade to the
        // plain template icon rather than throw an uncaught exception into them.
        console.warn('[system-tray] macOS attention icon failed; showing plain icon', error)
      }
    }

    baseTrayImage.setTemplateImage(true)
    tray.setImage(baseTrayImage)
    tray.setToolTip(baseTooltip())
    return
  }

  tray.setImage(attentionActive ? composeTrayAttentionIcon(baseTrayImage) : baseTrayImage)
}

function createMacMenuBarImage(): NativeImage | null {
  const image = nativeImage.createFromPath(menuBarIconPath)
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) {
    console.warn('[system-tray] macOS menu bar icon could not be loaded')
    return null
  }

  const retinaImage = nativeImage.createFromPath(menuBarIconRetinaPath)
  const retinaSize = retinaImage.getSize()
  if (retinaSize.width > 0 && retinaSize.height > 0) {
    try {
      // Why: importing the @2x asset guarantees it is packaged; adding the
      // representation explicitly avoids relying on bundler-renamed siblings.
      image.addRepresentation({
        scaleFactor: 2,
        dataURL: retinaImage.toDataURL()
      })
    } catch (error) {
      // Why: a bad @2x representation must not abort tray creation; the 1x image
      // still renders (just blurrier on Retina).
      console.warn('[system-tray] macOS retina menu bar icon could not be added', error)
    }
  } else {
    // Why: surface the silently-degraded (non-Retina) icon so a blurry menu-bar
    // glyph on a modern display is diagnosable, matching the base-image warning.
    console.warn('[system-tray] macOS retina menu bar icon could not be loaded')
  }
  image.setTemplateImage(true)
  return image
}

// Why: dev builds reuse the production template glyph, so without a marker a
// dev status item is indistinguishable from the installed app's. Stamping the
// badge into the template (instead of tray.setTitle) keeps the status item at
// the exact production width, and the attention tint path inherits it since it
// reads these same pixels.
function stampMacDevBadge(base: NativeImage): NativeImage {
  try {
    const stamped = stampTrayDevBadge(base)
    if (base.getScaleFactors().includes(2)) {
      // Why: createFromBitmap starts from 1x pixels only, so the @2x
      // representation must be rebuilt or the badge blurs on Retina.
      const retinaStamped = stampTrayDevBadge(base, 2)
      stamped.addRepresentation({
        scaleFactor: 2,
        dataURL: retinaStamped.toDataURL()
      })
    }
    stamped.setTemplateImage(true)
    return stamped
  } catch (error) {
    // Why: the badge is diagnostics-only chrome; a NativeImage failure must
    // degrade to the plain icon, not abort tray creation.
    console.warn('[system-tray] dev badge could not be stamped; showing plain icon', error)
    return base
  }
}

function watchMacAppearance(): void {
  if (nativeThemeUpdatedListener) {
    return
  }
  nativeThemeUpdatedListener = () => {
    if (attentionActive) {
      applyTrayImage()
    }
  }
  nativeTheme.on('updated', nativeThemeUpdatedListener)
}

function stopWatchingMacAppearance(): void {
  if (!nativeThemeUpdatedListener) {
    return
  }
  nativeTheme.removeListener('updated', nativeThemeUpdatedListener)
  nativeThemeUpdatedListener = null
}

// Why: Electron Menu/Tray click callbacks are plain event listeners (not
// promise-wrapped like ipcMain.handle), so an uncaught throw here is fatal to
// the main process; contain it to a logged, failed menu action instead.
function safeMenuAction(action: () => void): () => void {
  return () => {
    try {
      action()
    } catch (error) {
      console.error('[system-tray] menu action failed', error)
    }
  }
}

/**
 * Creates the Windows notification icon or macOS menu bar status item. No-op
 * on Linux. Idempotent: repeated calls never stack duplicate icons.
 */
export function createSystemTray(opts: SystemTrayOptions): Tray | null {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return null
  }
  if (tray && !tray.isDestroyed()) {
    return tray
  }

  devIndicator = opts.isDevInstance ? { label: opts.devInstanceLabel } : null

  if (process.platform === 'darwin') {
    baseTrayImage = createMacMenuBarImage()
    if (!baseTrayImage) {
      return null
    }
    if (devIndicator) {
      baseTrayImage = stampMacDevBadge(baseTrayImage)
    }
  } else {
    baseTrayImage = createAppIconImage(opts.appIcon).resize({
      width: TRAY_ICON_SIZE,
      height: TRAY_ICON_SIZE
    })
  }

  tray = new Tray(baseTrayImage)
  // Why: reflect any attention event that fired before the tray existed.
  applyTrayImage()

  const menu = Menu.buildFromTemplate([
    ...(devIndicator
      ? ([
          // Why: several dev instances (one per worktree) can show trays at
          // once; the disabled header ties this one to its worktree/branch.
          { label: baseTooltip(), enabled: false },
          { type: 'separator' }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: translateMain('tray.openOrca', 'Open Orca'),
      click: safeMenuAction(() => opts.onOpen())
    },
    { type: 'separator' },
    // Why: reuse the app menu's keys so the two entry points never drift.
    ...(process.platform === 'darwin'
      ? ([
          {
            label: translateMain('menu.settings', 'Settings'),
            click: safeMenuAction(() => opts.onOpenSettings())
          },
          {
            label: translateMain('menu.checkForUpdates', 'Check for Updates...'),
            click: safeMenuAction(() => opts.onCheckForUpdates())
          },
          { type: 'separator' }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    { label: translateMain('tray.quit', 'Quit'), click: safeMenuAction(() => opts.onQuit()) }
  ])
  tray.setContextMenu(menu)
  if (process.platform === 'win32') {
    tray.setToolTip(baseTooltip())
    // Why: a left-click on the tray icon is the conventional Windows gesture to
    // restore a minimized-to-tray app; macOS opens the attached menu instead.
    tray.on(
      'click',
      safeMenuAction(() => opts.onOpen())
    )
  } else {
    watchMacAppearance()
  }
  return tray
}

/** Applies the persisted macOS visibility preference without affecting Windows. */
export function setMacMenuBarIconVisible(visible: boolean, opts: SystemTrayOptions): Tray | null {
  if (process.platform !== 'darwin') {
    return null
  }
  if (!visible) {
    destroySystemTray()
    return null
  }
  return createSystemTray(opts)
}

/**
 * Shows or hides a red/amber attention dot on the tray icon. Call with `true`
 * when a terminal bell or agent completion fires while the window is
 * minimized/hidden, and `false` once the window is shown again. Safe to call
 * before the tray is created or on Linux where no tray is available.
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
  stopWatchingMacAppearance()
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
  baseTrayImage = null
  // Why: attention is owned by the notification/visibility flow, and must
  // survive the macOS hide/show toggle so a re-shown icon keeps its dot.
}
