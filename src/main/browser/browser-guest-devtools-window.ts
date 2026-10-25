import { BrowserWindow, screen } from 'electron'
import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../shared/keybindings'

type ScreenRect = { x: number; y: number; width: number; height: number }

const CURSOR_POLL_MS = 16
const GEOMETRY_REFRESH_MS = 250

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
  // DevTools emits input-event, not before-input-event; closing it also destroys this listener.
  devTools.on('input-event', (_event, inputEvent) => {
    const input = readKeyDown(inputEvent)
    if (
      !input ||
      !keybindingMatchesAction('tab.close', input, process.platform, getKeybindings())
    ) {
      return
    }
    // Defer closing until AppKit finishes routing the key to avoid a performKeyEquivalent crash.
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

// Relay hover while DevTools has focus: macOS Chromium drops moves to non-key windows (#22789).
function installMacHoverRelay(
  guest: Electron.WebContents,
  devTools: Electron.WebContents,
  isViewportEmulated: () => boolean
): void {
  let cursorTimer: ReturnType<typeof setInterval> | null = null
  let geometryTimer: ReturnType<typeof setTimeout> | null = null
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
    // Re-arm after the read to avoid piling up calls while the renderer is busy.
    if (cursorTimer && !geometryTimer) {
      geometryTimer = setTimeout(() => {
        geometryTimer = null
        void refreshGeometry()
      }, GEOMETRY_REFRESH_MS)
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
      clearTimeout(geometryTimer)
      geometryTimer = null
    }
    guestRect = null
    lastPoint = null
  }

  const start = (): void => {
    if (cursorTimer) {
      return
    }
    cursorTimer = setInterval(relayCursor, CURSOR_POLL_MS)
    void refreshGeometry()
  }

  devTools.on('focus', start)
  devTools.on('blur', stop)
  devTools.once('destroyed', stop)
  if (devTools.isFocused()) {
    start()
  }
}
