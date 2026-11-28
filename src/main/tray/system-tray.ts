import { Menu, Tray, nativeTheme, type NativeImage } from 'electron'
import { deferAppKitSceneMutation } from '../window/desktop-integration/appkit-scene-mutation'
import { createAppIconImage } from '../window/desktop-integration/app-icon'
import { translateMain } from '../i18n/main-i18n'
import { quitAndStopAllSessionsMenuText } from '../menu/app-menu-quit-item'
import { composeTrayAttentionIcon, tintTrayTemplateForAttention } from './tray-attention-icon'
import { createMacMenuBarImage, stampMacDevBadge } from './mac-menu-bar-image'
import { MacMenuBarTray, waitForMacMenuBarRetirement, type TrayMenuItem } from './mac-menu-bar-tray'

import type { MenuBarQACommand } from './mac-menu-bar-protocol'
import {
  awaitMacIconShown,
  inProcessMenuBarHost,
  launchMacMenuBarHost,
  markMacIconShown,
  markMacMenuBarHelperUnavailable,
  reportMenuBarHost
} from './mac-menu-bar-host'

export type SystemTray = Tray | MacMenuBarTray

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
  /** Confirm, then quit with every terminal session stopped; omitted where the item must not show (serve mode). */
  onQuitAndStopAllSessions?: () => void
  /** Buckets the macOS menu-bar helper rollout. */
  installId: string | null
  onCreated?: () => void
}

// Keep a live reference or Electron GC removes the tray icon.
let tray: SystemTray | null = null
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
export function createSystemTray(opts: SystemTrayOptions): SystemTray | null {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return null
  }
  if (process.platform === 'darwin') {
    awaitMacIconShown(opts.onCreated)
  }
  if (tray && !tray.isDestroyed()) {
    return tray
  }
  if (process.platform === 'darwin' && launchMacMenuBarHost(opts.installId) === 'off') {
    return null
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

  // The helper owns NSStatusItem so AppKit scene deadlocks cannot freeze main.
  if (process.platform === 'darwin' && launchMacMenuBarHost(opts.installId) === 'helper') {
    const helperTray: MacMenuBarTray = new MacMenuBarTray(baseTrayImage, {
      onCreated: () => markMacIconShown(true),
      onOwnerChange: (owned) => reportMenuBarHost(owned ? 'helper' : null),
      onUnavailable: (reason) => {
        // Recorded now so a toggle before the deferred swap can't relaunch the helper with fresh strikes.
        markMacMenuBarHelperUnavailable(reason === 'fallback' ? 'in-process' : 'off')
        deferAppKitSceneMutation(() => replaceFailedHelperTray(helperTray, reason))
      }
    })
    tray = helperTray
  } else {
    tray = createNativeTray(baseTrayImage, opts)
  }
  applyTrayImage()
  trayOptions = opts
  setTrayMenu(opts)
  if (process.platform === 'win32') {
    tray.setToolTip(baseTooltip())
  } else {
    watchMacAppearance()
  }
  return tray
}

function createNativeTray(image: NativeImage, opts: SystemTrayOptions): Tray {
  const nativeTray = new Tray(image)
  if (process.platform === 'win32') {
    // Windows left-click restores the app; macOS uses its attached menu.
    nativeTray.on(
      'click',
      safeMenuAction(() => opts.onOpen())
    )
  } else {
    reportMenuBarHost(inProcessMenuBarHost())
    markMacIconShown(true)
  }
  return nativeTray
}

// A helper that can't start falls back to the in-process icon; one that starts and keeps hanging
// would hang main the same way in-process, so the icon stays off for this launch instead.
function replaceFailedHelperTray(failed: MacMenuBarTray, reason: 'fallback' | 'off'): void {
  if (tray !== failed || !trayOptions || !baseTrayImage) {
    return
  }
  void failed.destroy()
  if (reason === 'off') {
    tray = null
    reportMenuBarHost('helper-gave-up')
    return
  }
  tray = createNativeTray(baseTrayImage, trayOptions)
  setTrayMenu(trayOptions)
  applyTrayImage()
}

function setTrayMenu(opts: SystemTrayOptions): void {
  const menu = buildTrayMenu(opts)
  if (tray instanceof MacMenuBarTray) {
    tray.setMenu(menu)
  } else {
    tray?.setContextMenu(Menu.buildFromTemplate(menu))
  }
}

function buildTrayMenu(opts: SystemTrayOptions): TrayMenuItem[] {
  return [
    ...(devIndicator
      ? ([
          // Label dev trays by worktree/branch to distinguish concurrent instances.
          { label: baseTooltip(), enabled: false },
          { type: 'separator' }
        ] satisfies TrayMenuItem[])
      : []),
    {
      id: 'open',
      label: translateMain('tray.openOrca', 'Open Orca'),
      click: safeMenuAction(() => opts.onOpen())
    },
    { type: 'separator' },
    // Share app-menu translation keys so tray labels cannot drift.
    ...(process.platform === 'darwin'
      ? ([
          {
            id: 'settings',
            label: translateMain('menu.settings', 'Settings'),
            click: safeMenuAction(() => opts.onOpenSettings())
          },
          {
            id: 'updates',
            label: translateMain('menu.checkForUpdates', 'Check for Updates...'),
            click: safeMenuAction(() => opts.onCheckForUpdates())
          },
          { type: 'separator' }
        ] satisfies TrayMenuItem[])
      : []),
    ...(opts.onQuitAndStopAllSessions
      ? ([
          {
            id: 'quit-completely',
            ...quitAndStopAllSessionsMenuText(),
            click: safeMenuAction(opts.onQuitAndStopAllSessions)
          }
        ] satisfies TrayMenuItem[])
      : []),
    {
      id: 'quit',
      label: translateMain('tray.quit', 'Quit'),
      click: safeMenuAction(() => opts.onQuit())
    }
  ]
}

/** Refreshes translated labels without recreating the tray or its actions. */
export function rebuildSystemTrayMenu(): void {
  // Native tray writes must run outside AppKit callbacks.
  deferAppKitSceneMutation(() => {
    if (!tray || tray.isDestroyed() || !trayOptions) {
      return
    }
    setTrayMenu(trayOptions)
    applyTrayImage()
  })
}

/** Applies the persisted macOS visibility preference without affecting Windows. */
export function setMacMenuBarIconVisible(
  visible: boolean,
  opts: SystemTrayOptions
): SystemTray | null {
  if (process.platform !== 'darwin') {
    return null
  }
  if (!visible) {
    void destroySystemTray()
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

export function destroySystemTray(): Promise<void> {
  stopWatchingMacAppearance()
  if (tray) {
    reportMenuBarHost(null)
    markMacIconShown(false)
  }
  if (tray && !tray.isDestroyed()) {
    void tray.destroy()
  }
  tray = null
  trayOptions = null
  baseTrayImage = null
  // Notification/visibility flow owns attention; preserve its dot across menu-bar icon hide/show.
  return waitForMacMenuBarRetirement()
}

export function inspectSystemTrayForQA(command: MenuBarQACommand): Promise<unknown> {
  return tray instanceof MacMenuBarTray
    ? tray.inspectForQA(command)
    : Promise.reject(new Error('Native menu bar helper unavailable'))
}
