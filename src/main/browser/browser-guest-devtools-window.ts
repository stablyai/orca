import { BrowserWindow, screen } from 'electron'
import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../shared/keybindings'

type ScreenRect = { x: number; y: number; width: number; height: number }

const CURSOR_POLL_MS = 16
const GEOMETRY_REFRESH_MS = 250

/**
 * A page's DevTools open in their own window, which Orca's app menu and shortcut routing never
 * see. Give that window the two behaviours Chrome's has: the close-tab chord closes it, and on
 * macOS the page still gets hover while it is focused, so inspect mode can highlight.
 */
export function installGuestDevToolsWindowBehavior(args: {
  guest: Electron.WebContents
  getKeybindings: () => KeybindingOverrides | undefined
  // Emulated viewports scale the guest, so host geometry no longer maps to page coordinates.
  isViewportEmulated: () => boolean
}): () => void {
  const { guest, getKeybindings, isViewportEmulated } = args
  const handleOpened = (): void => {
    const devTools = guest.devToolsWebContents
    if (!devTools || devTools.isDestroyed()) {
      return
    }
    installCloseShortcut(guest, devTools, getKeybindings)
    if (process.platform === 'darwin') {
      installMacHoverRelay(guest, devTools, isViewportEmulated)
    }
  }
  guest.on('devtools-opened', handleOpened)
  return () => {
    try {
      guest.off('devtools-opened', handleOpened)
    } catch {
      // guest may already be destroyed
    }
  }
}

// input-event is typed as the generic InputEvent, but key events carry key/code at runtime.
function readKeyDown(input: Electron.InputEvent): KeybindingInput | null {
  const modifiers = input.modifiers ?? []
  if (input.type !== 'rawKeyDown' || modifiers.includes('isautorepeat')) {
    return null
  }
  if (!('key' in input) || typeof input.key !== 'string') {
    return null
  }
  return {
    key: input.key,
    code: 'code' in input && typeof input.code === 'string' ? input.code : undefined,
    meta: modifiers.includes('meta'),
    control: modifiers.includes('control'),
    alt: modifiers.includes('alt'),
    shift: modifiers.includes('shift')
  }
}

function installCloseShortcut(
  guest: Electron.WebContents,
  devTools: Electron.WebContents,
  getKeybindings: () => KeybindingOverrides | undefined
): void {
  // Why input-event: Electron never emits before-input-event for a DevTools webContents.
  // The listener dies with the DevTools webContents, which is destroyed on close.
  devTools.on('input-event', (_event, inputEvent) => {
    const input = readKeyDown(inputEvent)
    if (
      !input ||
      !keybindingMatchesAction('tab.close', input, process.platform, getKeybindings())
    ) {
      return
    }
    // Why deferred: AppKit is still routing this key through the DevTools view; destroying it
    // synchronously crashes in performKeyEquivalent.
    setImmediate(() => {
      if (!guest.isDestroyed()) {
        guest.closeDevTools()
      }
    })
  })
}

function contains(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

// Match by guest id: the live <webview> moves between the pane viewport and the retained host.
function webviewRectScript(guestId: number): string {
  return `(() => {
    for (const el of document.querySelectorAll('webview')) {
      let id = null
      try { id = el.getWebContentsId() } catch {}
      if (id !== ${guestId}) continue
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    return null
  })()`
}

async function readGuestScreenRect(guest: Electron.WebContents): Promise<ScreenRect | null> {
  const host = guest.hostWebContents
  const window = host ? BrowserWindow.fromWebContents(host) : null
  if (!host || !window || window.isDestroyed() || window.isMinimized() || !window.isVisible()) {
    return null
  }
  const rect: ScreenRect | null = await host.executeJavaScript(webviewRectScript(guest.id))
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null
  }
  const content = window.getContentBounds()
  const zoom = host.getZoomFactor()
  return {
    x: content.x + rect.x * zoom,
    y: content.y + rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom
  }
}

/**
 * Why: on macOS Chromium drops mouse moves for views in a window that is neither main nor key.
 * Chrome lifts that while a debugger is attached; Electron does not, so while the DevTools window
 * is key the page never sees hover (#22789). Relay the cursor into the page instead.
 */
function installMacHoverRelay(
  guest: Electron.WebContents,
  devTools: Electron.WebContents,
  isViewportEmulated: () => boolean
): void {
  let cursorTimer: ReturnType<typeof setInterval> | null = null
  let geometryTimer: ReturnType<typeof setInterval> | null = null
  let guestRect: ScreenRect | null = null
  let devToolsRect: ScreenRect | null = null
  let lastPoint: { x: number; y: number } | null = null

  const refreshGeometry = async (): Promise<void> => {
    if (guest.isDestroyed() || devTools.isDestroyed()) {
      guestRect = null
      return
    }
    try {
      ;[guestRect, devToolsRect] = await Promise.all([
        readGuestScreenRect(guest),
        devTools.executeJavaScript(
          '({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight })'
        )
      ])
    } catch {
      guestRect = null
    }
  }

  const relayCursor = (): void => {
    if (guest.isDestroyed() || !guestRect || isViewportEmulated()) {
      return
    }
    const cursor = screen.getCursorScreenPoint()
    // The DevTools window may overlap the page; the cursor over it belongs to DevTools.
    const overPage =
      contains(guestRect, cursor.x, cursor.y) &&
      !(devToolsRect && contains(devToolsRect, cursor.x, cursor.y))
    if (!overPage) {
      if (lastPoint) {
        lastPoint = null
        guest.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 })
      }
      return
    }
    const x = Math.round(cursor.x - guestRect.x)
    const y = Math.round(cursor.y - guestRect.y)
    if (lastPoint?.x === x && lastPoint.y === y) {
      return
    }
    lastPoint = { x, y }
    guest.sendInputEvent({ type: 'mouseMove', x, y })
  }

  const stop = (): void => {
    if (cursorTimer) {
      clearInterval(cursorTimer)
      cursorTimer = null
    }
    if (geometryTimer) {
      clearInterval(geometryTimer)
      geometryTimer = null
    }
    guestRect = null
    lastPoint = null
  }

  const start = (): void => {
    if (cursorTimer) {
      return
    }
    void refreshGeometry()
    geometryTimer = setInterval(() => void refreshGeometry(), GEOMETRY_REFRESH_MS)
    cursorTimer = setInterval(relayCursor, CURSOR_POLL_MS)
  }

  devTools.on('focus', start)
  devTools.on('blur', stop)
  // A destroyed guest takes its DevTools with it, so this also covers guest teardown.
  devTools.once('destroyed', stop)
  if (devTools.isFocused()) {
    start()
  }
}
