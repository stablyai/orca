import { BrowserWindow, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { Store } from '../persistence'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'
import { clampPetSize, type PetWindowPosition } from '../../shared/pet-types'
import { defaultPetWindowPosition, petWindowSizeForPetSize } from '../../shared/pet-window-geometry'

const DESKTOP_PET_PARTITION = 'orca-desktop-pet'
// Why: the pet must stay grabbable after a monitor unplug, so require most of the window
// on-screen rather than the sliver rule that suits a titlebar-draggable window.
const MIN_VISIBLE_FRACTION = 0.5

// Why: singleton — one pet, so a second detach request just re-reveals this window.
let desktopPetWindow: BrowserWindow | null = null

export function getDesktopPetWindow(): BrowserWindow | null {
  return desktopPetWindow &&
    !desktopPetWindow.isDestroyed() &&
    !desktopPetWindow.webContents.isDestroyed()
    ? desktopPetWindow
    : null
}

export function isDesktopPetRenderer(sender: WebContents): boolean {
  return getDesktopPetWindow()?.webContents === sender
}

function resolvePetWindowSize(store: Store | null): number {
  return petWindowSizeForPetSize(clampPetSize(store?.getUI().petSize))
}

function resolveStartPosition(store: Store | null, windowSize: number): PetWindowPosition {
  const saved = store?.getUI().petWindowPosition ?? null
  if (
    saved &&
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    rectHasVisibleAreaOnAnyDisplay(
      { x: saved.x, y: saved.y, width: windowSize, height: windowSize },
      windowSize * MIN_VISIBLE_FRACTION,
      windowSize * MIN_VISIBLE_FRACTION
    )
  ) {
    return { x: Math.round(saved.x), y: Math.round(saved.y) }
  }
  if (saved) {
    console.warn('[desktop-pet] Discarding off-screen pet window position:', saved)
  }
  return defaultPetWindowPosition(screen.getPrimaryDisplay().workArea, windowSize)
}

function loadDesktopPet(window: BrowserWindow): void {
  // Why: mirror loadMainWindow's dev/prod branch — the dev server serves the
  // extra HTML entry, prod loads the emitted file.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/pet.html`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/pet.html'))
  }
}

/**
 * Open the detached pet window, or reveal it if already open. It is a frameless transparent
 * always-on-top BrowserWindow that reuses the same preload/window.api as the main window but
 * renders its own React root (pet.html) — so the pet outlives a minimized or backgrounded
 * main window instead of being clipped to it.
 */
export function createOrRevealDesktopPetWindow(store: Store | null): BrowserWindow {
  const existing = getDesktopPetWindow()
  if (existing) {
    existing.showInactive()
    return existing
  }

  const windowSize = resolvePetWindowSize(store)
  const position = resolveStartPosition(store, windowSize)

  const window = new BrowserWindow({
    width: windowSize,
    height: windowSize,
    x: position.x,
    y: position.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Why: a pet that steals focus from the editor on every pat is worse than no pet. Mouse
    // events still reach a non-focusable window on all three platforms.
    focusable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    title: 'Orca Pet',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      // Why: Chromium shares zoom by origin; an isolated session keeps the app-wide UI zoom
      // off the pet, whose window is sized in raw pixels by the main process.
      partition: DESKTOP_PET_PARTITION,
      webviewTag: false,
      backgroundThrottling: false
    }
  })
  installPrivilegedWindowNavigationPolicy(window.webContents)
  // Why: isolated sessions do not inherit the main session's deny-by-default permission policy.
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  // Why: 'screen-saver' is the level that keeps an overlay above full-screen apps; plain
  // alwaysOnTop sits below them on macOS.
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  desktopPetWindow = window

  const unsubscribeUIChanged = store?.onUIChanged((ui) => {
    const nextSize = petWindowSizeForPetSize(clampPetSize(ui.petSize))
    if (window.isDestroyed() || window.getBounds().width === nextSize) {
      return
    }
    const bounds = window.getBounds()
    window.setBounds({ x: bounds.x, y: bounds.y, width: nextSize, height: nextSize })
  })

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      // Why: showInactive, not show — revealing the pet must not pull focus off the terminal.
      window.showInactive()
    }
  })

  window.on('closed', () => {
    unsubscribeUIChanged?.()
    if (desktopPetWindow === window) {
      desktopPetWindow = null
    }
  })

  loadDesktopPet(window)
  return window
}

/** Move the pet window to a screen position and remember it. Called from the pet renderer's
 *  drag; the position is clamped to a display so a fling can't strand the pet off-screen. */
export function moveDesktopPetWindow(store: Store | null, position: PetWindowPosition): void {
  const window = getDesktopPetWindow()
  if (!window) {
    return
  }
  const { width } = window.getBounds()
  const next = { x: Math.round(position.x), y: Math.round(position.y) }
  if (
    !rectHasVisibleAreaOnAnyDisplay(
      { ...next, width, height: width },
      width * MIN_VISIBLE_FRACTION,
      width * MIN_VISIBLE_FRACTION
    )
  ) {
    return
  }
  window.setPosition(next.x, next.y)
  store?.updateUI({ petWindowPosition: next })
}

/** Let clicks fall through to whatever is behind the pet's transparent corners. The renderer
 *  drives this from its own hit test; `forward` keeps mouse moves flowing so it can flip back. */
export function setDesktopPetInteractive(interactive: boolean): void {
  const window = getDesktopPetWindow()
  if (!window) {
    return
  }
  window.setIgnoreMouseEvents(!interactive, { forward: true })
}

/** Close the detached pet. Called when the pet is re-docked, disabled, or the main window
 *  closes — an orphaned pet window would otherwise keep the app alive on Windows/Linux. */
export function closeDesktopPetWindow(): void {
  const window = desktopPetWindow
  desktopPetWindow = null
  if (window && !window.isDestroyed()) {
    window.destroy()
  }
}
