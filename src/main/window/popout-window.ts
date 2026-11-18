import { mainI18n } from '../i18n/main-i18n'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import type { Store } from '../persistence/loading-store/store'
import {
  isBackgroundLaunch,
  showWindowWithoutStealingFocus
} from './activation/foreground-activation-policy'
import { installPrivilegedWindowNavigationPolicy } from './security/privileged-window-navigation'
import {
  stepUIZoomLevel,
  type UIZoomDirection
} from '../../shared/app-lifecycle/windows/ui-zoom-level'
import { nativeZoomCommandMatchesKeybindings } from '../../shared/keybindings/window-shortcut-policy'
import { keybindingMatchesAction } from '../../shared/keybindings/matching'
import type {
  KeybindingActionId,
  KeybindingInput,
  KeybindingOverrides
} from '../../shared/keybindings/types'
import { wslHostsWindowArguments } from '../wsl/host-lifecycle/wsl-host-gate'
import { isMacAppPasteInput } from './editing/mac-app-paste-input'

export type PopoutWindowOptions = {
  getTitle: () => string
  partition: string
  bounds: { width: number; height: number; x?: number; y?: number }
  minWidth: number
  minHeight: number
  /** popout.tsx picks its root from this; the dashboard passes none. */
  query?: Record<string, string>
  getKeybindings?: () => KeybindingOverrides | undefined
}

const popoutWindows = new Set<BrowserWindow>()

function zoomPopout(window: BrowserWindow, direction: UIZoomDirection): void {
  const webContents = window.webContents
  webContents.setZoomLevel(stepUIZoomLevel(webContents.getZoomLevel(), direction))
}

const ZOOM_SHORTCUTS: readonly [KeybindingActionId, UIZoomDirection][] = [
  ['zoom.in', 'in'],
  ['zoom.out', 'out'],
  ['zoom.reset', 'reset']
]

function resolveZoomShortcut(
  input: KeybindingInput,
  keybindings: KeybindingOverrides | undefined
): UIZoomDirection | null {
  // This runs per keydown; inspect only zoom shortcuts.
  for (const [actionId, direction] of ZOOM_SHORTCUTS) {
    if (
      keybindingMatchesAction(actionId, input, process.platform, keybindings, { context: 'app' })
    ) {
      return direction
    }
  }
  return null
}

/** Zoom the focused popout; return false so menu actions can fall back to the main window. */
export function zoomPopoutIfFocused(direction: UIZoomDirection): boolean {
  for (const window of popoutWindows) {
    if (!window.isDestroyed() && window.isFocused()) {
      zoomPopout(window, direction)
      return true
    }
  }
  return false
}

export function revealPopoutWindow(window: BrowserWindow): void {
  if (window.webContents.isCrashed()) {
    window.webContents.reload()
  }
  if (window.isMinimized()) {
    window.restore()
  }
  if (!isBackgroundLaunch()) {
    window.focus()
  }
}

function loadPopout(window: BrowserWindow, query: Record<string, string> | undefined): void {
  // Match main-window loading: dev server entry versus packaged emitted HTML.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const search = query ? `?${new URLSearchParams(query).toString()}` : ''
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/popout.html${search}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/popout.html'), query ? { query } : undefined)
  }
}

/** A native-framed companion window with the main preload and its own popout.html renderer. */
export function createPopoutWindow(
  store: Store | null,
  options: PopoutWindowOptions
): BrowserWindow {
  // Serve-only: this window lists saved WSL hosts and their Connect, as the main window does.
  const wslArguments = wslHostsWindowArguments()
  const window = new BrowserWindow({
    ...options.bounds,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    title: options.getTitle(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    // Use native movable/closable chrome on every platform; the popout renders no custom titlebar.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      // Chromium shares zoom by origin; isolate the session to keep popout zoom local.
      partition: options.partition,
      // No webviews run here; disable embedding and omit host identity so client-placed pages stay mirrors.
      webviewTag: false,
      ...(wslArguments.length > 0 ? { additionalArguments: wslArguments } : {})
    }
  })
  installPrivilegedWindowNavigationPolicy(window.webContents)
  // Isolated sessions do not inherit the main session's deny-by-default permission policy.
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  popoutWindows.add(window)

  // Apply persisted app zoom or the popout always opens at 100%.
  window.webContents.on('dom-ready', () => {
    if (!window.isDestroyed()) {
      window.webContents.setZoomLevel(store?.getUI().uiZoomLevel ?? 0)
    }
  })
  // Compare against last app zoom, not live window zoom, so local changes persist until app-wide zoom actually changes.
  let lastFollowedZoomLevel = store?.getUI().uiZoomLevel ?? 0
  const unsubscribeUIChanged = store?.onUIChanged((ui) => {
    const level = ui.uiZoomLevel ?? 0
    if (level === lastFollowedZoomLevel) {
      return
    }
    lastFollowedZoomLevel = level
    if (!window.isDestroyed()) {
      window.webContents.setZoomLevel(level)
    }
  })

  // No renderer shortcut routing exists here; handle paste and zoom chords and yield everything else.
  window.webContents.on('before-input-event', (event, input) => {
    if (isMacAppPasteInput(input)) {
      // Kitty-mode xterm encodes Cmd+V as CSI u and consumes it, so the Edit menu accelerator never fires.
      event.preventDefault()
      window.webContents.send('ui:appMenuPaste')
      return
    }
    if (input.type !== 'keyDown') {
      return
    }
    const direction = resolveZoomShortcut(input, options.getKeybindings?.())
    if (direction) {
      event.preventDefault()
      zoomPopout(window, direction)
    }
  })

  window.webContents.on('zoom-changed', (event, direction) => {
    // Ctrl/Cmd+wheel arrives outside keyboard input routing.
    if (
      (direction === 'in' || direction === 'out') &&
      nativeZoomCommandMatchesKeybindings(direction, process.platform, options.getKeybindings?.(), {
        context: 'app'
      })
    ) {
      event.preventDefault()
      zoomPopout(window, direction)
    }
  })

  window.once('ready-to-show', () => {
    showWindowWithoutStealingFocus(window)
  })

  window.on('page-title-updated', (event) => {
    event.preventDefault()
  })
  const updateTitle = (): void => {
    if (!window.isDestroyed()) {
      window.setTitle(options.getTitle())
    }
  }
  mainI18n.on('languageChanged', updateTitle)

  window.on('closed', () => {
    popoutWindows.delete(window)
    mainI18n.off('languageChanged', updateTitle)
    unsubscribeUIChanged?.()
  })

  loadPopout(window, options.query)
  return window
}
