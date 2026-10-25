import { Menu, Tray, nativeImage, nativeTheme, type NativeImage } from 'electron'
import menuBarIconPath from '../../../resources/tray/orca-menu-barTemplate.png?asset&asarUnpack'
import menuBarIconRetinaPath from '../../../resources/tray/orca-menu-barTemplate@2x.png?asset&asarUnpack'
import { deferAppKitSceneMutation } from '../appkit-scene-mutation'
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
  /** Caller must mark quit intent; serve-mode user Quit may close only desktop windows. */
  onQuit: () => void
}

// Keep a live reference or Electron GC removes the tray icon.
let tray: Tray | null = null
let trayOptions: SystemTrayOptions | null = null

// Cache the plain icon so attention changes do not reload the app PNG.
let baseTrayImage: NativeImage | null = null

// Remember attention before deferred tray creation so its first image is current.
let attentionActive = false

// Keep dev identity across attention-triggered tooltip rebuilds.
let devIndicator: { label: string | null } | null = null

let nativeThemeUpdatedListener: (() => void) | null = null

// Per-worktree tooltips distinguish concurrent dev instances.
function baseTooltip(): string {
  if (!devIndicator) {
    return 'Orca'
  }
  return devIndicator.label ? `Orca DEV (${devIndicator.label})` : 'Orca DEV'
}

// Downscale the app image for Windows' 16px notification-area slot.
const TRAY_ICON_SIZE = 16

function applyTrayImage(): void {
  if (!tray || tray.isDestroyed() || !baseTrayImage) {
    return
  }

  if (process.platform === 'darwin') {
    if (attentionActive) {
      try {
        // Disabling template tint enables amber attention but requires theme-appropriate literal glyph pixels.
        const useLightGlyph = nativeTheme.shouldUseDarkColors
        const attentionImage = composeTrayAttentionIcon(
          tintTrayTemplateForAttention(baseTrayImage, useLightGlyph)
        )
        if (baseTrayImage.getScaleFactors().includes(2)) {
          // toBitmap reads 1x only; explicitly rebuild the 2x representation for Retina.
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
        // Native theme/bell callbacks are not guarded; image failures must fall back rather than escape into main.
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

// Coalesce repaint bursts and read current state in the deferred turn so dropped schedules cannot apply stale icons.
let trayImageRepaintPending = false

// NSStatusItem scene writes inside AppKit callouts deadlock main; defer them to a fresh turn.
function scheduleTrayImage(): void {
  if (trayImageRepaintPending) {
    return
  }
  trayImageRepaintPending = true
  deferAppKitSceneMutation(() => {
    trayImageRepaintPending = false
    applyTrayImage()
  })
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
      // Import/package the 2x asset explicitly instead of relying on bundler-renamed siblings.
      image.addRepresentation({
        scaleFactor: 2,
        dataURL: retinaImage.toDataURL()
      })
    } catch (error) {
      // Bad 2x data may blur Retina but must not abort tray creation.
      console.warn('[system-tray] macOS retina menu bar icon could not be added', error)
    }
  } else {
    // Report degraded Retina rendering so blurry status icons remain diagnosable.
    console.warn('[system-tray] macOS retina menu bar icon could not be loaded')
  }
  image.setTemplateImage(true)
  return image
}

// Badge dev pixels inside the production-width template; attention tint inherits them, unlike a separate tray title.
function stampMacDevBadge(base: NativeImage): NativeImage {
  try {
    const stamped = stampTrayDevBadge(base)
    if (base.getScaleFactors().includes(2)) {
      // Bitmap creation drops 2x data; rebuild it so the dev badge stays sharp on Retina.
      const retinaStamped = stampTrayDevBadge(base, 2)
      stamped.addRepresentation({
        scaleFactor: 2,
        dataURL: retinaStamped.toDataURL()
      })
    }
    stamped.setTemplateImage(true)
    return stamped
  } catch (error) {
    // Diagnostic dev badges must degrade to the plain icon rather than abort creation.
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
      // Appearance callbacks originate inside AppKit; defer native writes.
      scheduleTrayImage()
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

// Tray/menu listeners lack IPC promise guards; contain action failures rather than throw fatally into main.
function safeMenuAction(action: () => void): () => void {
  return () => {
    try {
      action()
    } catch (error) {
      console.error('[system-tray] menu action failed', error)
    }
  }
}

/** Create at most one Windows/macOS tray; Linux has none. */
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
  applyTrayImage()

  trayOptions = opts
  tray.setContextMenu(buildTrayMenu(opts))
  if (process.platform === 'win32') {
    tray.setToolTip(baseTooltip())
    // Windows left-click restores the app; macOS uses its attached menu.
    tray.on(
      'click',
      safeMenuAction(() => opts.onOpen())
    )
  } else {
    watchMacAppearance()
  }
  return tray
}

function buildTrayMenu(opts: SystemTrayOptions): Menu {
  return Menu.buildFromTemplate([
    ...(devIndicator
      ? ([
          // Label dev trays by worktree/branch to distinguish concurrent instances.
          { label: baseTooltip(), enabled: false },
          { type: 'separator' }
        ] satisfies Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: translateMain('tray.openOrca', 'Open Orca'),
      click: safeMenuAction(() => opts.onOpen())
    },
    { type: 'separator' },
    // Share app-menu translation keys so tray labels cannot drift.
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
        ] satisfies Electron.MenuItemConstructorOptions[])
      : []),
    { label: translateMain('tray.quit', 'Quit'), click: safeMenuAction(() => opts.onQuit()) }
  ])
}

/** Refreshes translated labels without recreating the tray or its actions. */
export function rebuildSystemTrayMenu(): void {
  // Native tray writes must run outside AppKit callbacks.
  deferAppKitSceneMutation(() => {
    if (!tray || tray.isDestroyed() || !trayOptions) {
      return
    }
    tray.setContextMenu(buildTrayMenu(trayOptions))
    applyTrayImage()
  })
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

/** Bell/completion attention survives pre-creation calls; notification/visibility flow clears it on reveal. Safe without a tray. */
export function setTrayAttention(active: boolean): void {
  if (attentionActive === active) {
    return
  }
  // Set dedup state synchronously; defer only native scene writes or rapid show/hide races mis-dedupe.
  attentionActive = active
  scheduleTrayImage()
}

export function destroySystemTray(): void {
  stopWatchingMacAppearance()
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
  trayOptions = null
  baseTrayImage = null
  // Notification/visibility flow owns attention; preserve its dot across menu-bar icon hide/show.
}
