import { app, BrowserWindow, type WebContents } from 'electron'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import type { NativeTerminalForwardedChord } from '../../shared/native-terminal-forwarded-chords'
import {
  NATIVE_TERMINAL_EVENT_CHANNEL,
  type NativeTerminalEvent,
  type NativeTerminalFrame
} from '../../shared/native-terminal-ipc'
import {
  loadGhosttyTerminalAddon,
  type GhosttyTerminalAddon
} from './ghostty-native-terminal-addon'
import { ghosttyConfigPath, writeGhosttyConfig } from './ghostty-native-terminal-config-file'
import { forgetGhosttySurfaceConfig } from './ghostty-native-terminal-surface-configs'
import {
  forgetNativeTerminalSurface,
  nativeTerminalSurfacePlaced
} from './ghostty-native-terminal-pty-feed'
import { installGhosttyDebugHooks } from './ghostty-native-terminal-debug-hooks'
import {
  appliedForwardedChords,
  applyForwardedChords,
  routeNativeInputEvent
} from './ghostty-native-terminal-input'

type SurfaceOwner = {
  webContents: WebContents
  window: BrowserWindow
  // The last frame (window points) the view was shown at; null until it is first placed.
  placed: { width: number; height: number } | null
}

const owners = new Map<number, SurfaceOwner>()
// The surface that is AppKit's first responder right now, per window.
const firstResponderByWindow = new Map<number, number>()
const trackedWindows = new WeakSet<BrowserWindow>()
let addon: GhosttyTerminalAddon | null = null
let initialized = false

function ensureInitialized(
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): GhosttyTerminalAddon | null {
  if (initialized) {
    return addon
  }
  addon = loadGhosttyTerminalAddon()
  if (!addon) {
    return null
  }
  const path = writeGhosttyConfig(appearance, zoomFactor) ?? ghosttyConfigPath()
  if (!addon.init(path)) {
    console.error('[native-terminal] Ghostty failed to initialize')
    addon = null
    return null
  }
  initialized = true
  app.on('did-become-active', () => addon?.setAppFocus(true))
  app.on('did-resign-active', () => addon?.setAppFocus(false))
  return addon
}

function sendEvent(owner: SurfaceOwner, event: NativeTerminalEvent): void {
  if (!owner.webContents.isDestroyed()) {
    owner.webContents.send(NATIVE_TERMINAL_EVENT_CHANNEL, event)
  }
}

function trackWindow(window: BrowserWindow, webContents: WebContents): void {
  if (trackedWindows.has(window)) {
    return
  }
  trackedWindows.add(window)
  // Surfaces live in this window's view tree; a reload or crash drops their renderer owner.
  const destroyAll = (): void => {
    for (const [surfaceId, owner] of owners) {
      if (owner.window === window) {
        destroySurface(surfaceId)
      }
    }
  }
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      destroyAll()
    }
  })
  webContents.on('render-process-gone', destroyAll)
  window.on('closed', destroyAll)
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function handleSurfaceEvent(surfaceId: number, kind: string, args: unknown[]): void {
  const owner = owners.get(surfaceId)
  if (!owner) {
    return
  }
  switch (kind) {
    case 'input':
      if (Buffer.isBuffer(args[0])) {
        sendEvent(owner, { surfaceId, kind: 'input', data: args[0].toString('utf8') })
      }
      return
    case 'resize': {
      // Ghostty reports grids for its creation placeholders (its default 800x600, then 1x1)
      // before the renderer places the view; only a grid for the shown frame may size the PTY.
      // Its sizes are backing pixels, never fewer than the frame's points.
      const width = Number(args[2])
      const height = Number(args[3])
      if (!owner.placed || width < owner.placed.width - 1 || height < owner.placed.height - 1) {
        return
      }
      sendEvent(owner, { surfaceId, kind: 'resize', cols: Number(args[0]), rows: Number(args[1]) })
      // Ghostty's terminal now has the pane's grid, so a main-fed seed lands where it should.
      nativeTerminalSurfacePlaced(surfaceId)
      return
    }
    case 'focus': {
      const focused = args[0] === true
      if (focused) {
        firstResponderByWindow.set(owner.window.id, surfaceId)
      } else if (firstResponderByWindow.get(owner.window.id) === surfaceId) {
        firstResponderByWindow.delete(owner.window.id)
      }
      sendEvent(owner, { surfaceId, kind: 'focus', focused })
      return
    }
    case 'contextMenu': {
      // Replay as a right click at the same window point so the pane's DOM context menu opens.
      const x = Math.round(Number(args[0]))
      const y = Math.round(Number(args[1]))
      owner.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
      owner.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
      return
    }
    case 'title':
      sendEvent(owner, { surfaceId, kind: 'title', title: String(args[0] ?? '') })
      return
    case 'openUrl': {
      const url = String(args[0] ?? '')
      // Ghostty detects links in PTY output, so whatever runs in the terminal picks this URL.
      if (isWebUrl(url)) {
        sendEvent(owner, { surfaceId, kind: 'openUrl', url })
      }
      return
    }
    case 'bell':
      sendEvent(owner, { surfaceId, kind: 'bell' })
      break
    default:
      routeNativeInputEvent(owner, surfaceId, kind, args, (event) => sendEvent(owner, event))
      break
  }
}

export function isNativeTerminalSupported(): boolean {
  return process.platform === 'darwin' && loadGhosttyTerminalAddon() !== null
}

export function createSurface(
  webContents: WebContents,
  appearance: NativeTerminalAppearance,
  zoomFactor: number,
  accessibilityLabel: string | null
): number | null {
  const window = BrowserWindow.fromWebContents(webContents)
  if (!window || window.isDestroyed()) {
    return null
  }
  const native = ensureInitialized(appearance, zoomFactor)
  if (!native) {
    return null
  }
  trackWindow(window, webContents)
  // Created hidden at zero size; the renderer's first frame report places it.
  const surfaceId = native.createSurface(
    window.getNativeWindowHandle(),
    0,
    0,
    1,
    1,
    (kind, ...args) => handleSurfaceEvent(surfaceId, kind, args)
  )
  owners.set(surfaceId, { webContents, window, placed: null })
  if (accessibilityLabel) {
    native.setSurfaceAccessibilityLabel(surfaceId, accessibilityLabel)
  }
  native.setFrames([[surfaceId, 0, 0, 1, 1, false]])
  return surfaceId
}

function ownedBy(surfaceId: number, webContents: WebContents): boolean {
  return owners.get(surfaceId)?.webContents === webContents
}

export function writeSurfaceOutput(
  webContents: WebContents,
  surfaceId: number,
  data: string
): void {
  if (addon && ownedBy(surfaceId, webContents)) {
    addon.writeOutput(surfaceId, Buffer.from(data, 'utf8'))
  }
}

export function setSurfaceFrames(webContents: WebContents, frames: NativeTerminalFrame[]): void {
  if (!addon) {
    return
  }
  const owned = frames.filter(([surfaceId]) => ownedBy(surfaceId, webContents))
  for (const [surfaceId, , , width, height, visible] of owned) {
    const owner = owners.get(surfaceId)
    // The addon applies a frame only while it is visible.
    if (owner && visible) {
      owner.placed = { width, height }
    }
  }
  addon.setFrames(owned)
}

export function focusSurface(webContents: WebContents, surfaceId: number): void {
  if (addon && ownedBy(surfaceId, webContents)) {
    addon.focus(surfaceId)
  }
}

export function setSurfaceShellPid(webContents: WebContents, surfaceId: number, pid: number): void {
  if (addon && ownedBy(surfaceId, webContents)) {
    addon.setSurfaceShellPid(surfaceId, pid)
  }
}

// Asks AppKit directly rather than the async focus events, which can trail a quick hand-off.
export function releaseSurfaceKeyboard(webContents: WebContents): void {
  addon?.releaseKeyboard(ownedSurfaceIds(webContents))
}

export function readSurfaceSelection(webContents: WebContents, surfaceId: number): string | null {
  return addon && ownedBy(surfaceId, webContents) ? addon.readSelection(surfaceId) : null
}

const MENU_ACTIONS = {
  copy: 'copy_to_clipboard',
  'select-all': 'select_all'
} as const

// Edit-menu copy/select-all while a native surface has the keyboard: the selection lives in
// Ghostty, not in the hidden xterm the renderer would read.
export function performNativeTerminalMenuAction(
  window: BrowserWindow,
  action: keyof typeof MENU_ACTIONS
): boolean {
  const surfaceId = firstResponderByWindow.get(window.id)
  if (!addon || surfaceId === undefined || !owners.has(surfaceId)) {
    return false
  }
  addon.performAction(surfaceId, MENU_ACTIONS[action])
  return true
}

function ownedSurfaceIds(webContents: WebContents): number[] {
  return [...owners].flatMap(([surfaceId, owner]) =>
    owner.webContents === webContents ? [surfaceId] : []
  )
}

function ownsAnySurface(webContents: WebContents): boolean {
  return ownedSurfaceIds(webContents).length > 0
}

// Only a renderer that hosts surfaces may change which keys they hand back.
export function setForwardedChords(
  webContents: WebContents,
  chords: NativeTerminalForwardedChord[]
): void {
  if (addon && ownsAnySurface(webContents)) {
    applyForwardedChords(addon, chords)
  }
}

// Ghostty's config is app-wide, so only a renderer that hosts surfaces may restyle them.
export function updateAppearance(
  webContents: WebContents,
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): void {
  if (!addon || !ownsAnySurface(webContents)) {
    return
  }
  const path = writeGhosttyConfig(appearance, zoomFactor)
  if (path) {
    addon.updateConfig(path)
  }
}

export function ownedSurfaceAddon(sender: WebContents, id: number): GhosttyTerminalAddon | null {
  return addon && ownedBy(id, sender) ? addon : null
}

export function destroySurface(surfaceId: number): void {
  const owner = owners.get(surfaceId)
  if (!owner) {
    return
  }
  owners.delete(surfaceId)
  if (firstResponderByWindow.get(owner.window.id) === surfaceId) {
    firstResponderByWindow.delete(owner.window.id)
  }
  addon?.destroySurface(surfaceId)
  forgetGhosttySurfaceConfig(surfaceId)
  forgetNativeTerminalSurface(surfaceId)
}

export function installNativeTerminalDebugHooks(): void {
  installGhosttyDebugHooks({
    surfaceIds: () => [...owners.keys()],
    addon: () => addon,
    forwardedChords: appliedForwardedChords
  })
}

export function destroyOwnedSurface(webContents: WebContents, surfaceId: number): void {
  if (ownedBy(surfaceId, webContents)) {
    destroySurface(surfaceId)
  }
}
