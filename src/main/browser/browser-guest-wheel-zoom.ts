import type { BrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import type { ResolveRenderer } from './browser-guest-renderer-target'

const CONTROL_MODIFIERS = new Set(['control', 'ctrl'])
const MAC_COMMAND_MODIFIERS = new Set(['meta', 'command', 'cmd'])
const WHEEL_ZOOM_BLOCKING_MODIFIERS = new Set(['alt', 'shift'])
const GUEST_WHEEL_ZOOM_DEDUPE_MS = 250

export type GuestWheelZoomDirection = Exclude<BrowserPageZoomDirection, 'reset'>

const recentGuestWheelZoomByGuest = new WeakMap<
  Electron.WebContents,
  { direction: GuestWheelZoomDirection; at: number }
>()

function markGuestWheelZoom(guest: Electron.WebContents, direction: GuestWheelZoomDirection): void {
  recentGuestWheelZoomByGuest.set(guest, { direction, at: Date.now() })
}

export function consumeRecentGuestWheelZoom(
  guest: Electron.WebContents,
  direction: GuestWheelZoomDirection
): boolean {
  const recent = recentGuestWheelZoomByGuest.get(guest)
  if (!recent) {
    return false
  }
  const elapsed = Date.now() - recent.at
  if (elapsed < 0 || elapsed > GUEST_WHEEL_ZOOM_DEDUPE_MS) {
    recentGuestWheelZoomByGuest.delete(guest)
    return false
  }
  if (recent.direction !== direction) {
    return false
  }
  recentGuestWheelZoomByGuest.delete(guest)
  return true
}

function hasModifier(mouse: Electron.MouseInputEvent, modifiers: ReadonlySet<string>): boolean {
  return mouse.modifiers?.some((modifier) => modifiers.has(modifier)) ?? false
}

export function resolveGuestMouseWheelZoomDirection(
  mouse: Electron.MouseInputEvent,
  platform: NodeJS.Platform = process.platform
): GuestWheelZoomDirection | null {
  if (mouse.type !== 'mouseWheel') {
    return null
  }
  if (hasModifier(mouse, WHEEL_ZOOM_BLOCKING_MODIFIERS)) {
    return null
  }
  const hasZoomModifier =
    hasModifier(mouse, CONTROL_MODIFIERS) ||
    (platform === 'darwin' && hasModifier(mouse, MAC_COMMAND_MODIFIERS))
  if (!hasZoomModifier) {
    return null
  }
  const deltaY = (mouse as Electron.MouseWheelInputEvent).deltaY
  if (typeof deltaY !== 'number' || deltaY === 0) {
    return null
  }
  return deltaY < 0 ? 'in' : 'out'
}

export function setupGuestMouseWheelZoomForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  isViewportPresetActive?: () => boolean
  canViewportScroll?: (mouse: Electron.MouseWheelInputEvent) => boolean
  onViewportWheelConsumed?: (deltaX: number, deltaY: number) => void
}): () => void {
  const {
    browserTabId,
    guest,
    resolveRenderer,
    isViewportPresetActive,
    canViewportScroll,
    onViewportWheelConsumed
  } = args
  const handler = (event: Electron.Event, mouse: Electron.MouseInputEvent): void => {
    const direction = resolveGuestMouseWheelZoomDirection(mouse)
    if (direction) {
      // Why: wheel input over a focused webview never reaches renderer DOM handlers, so consume and forward here.
      event.preventDefault()
      markGuestWheelZoom(guest, direction)
      resolveRenderer(browserTabId)?.send('ui:zoomBrowserPage', direction)
      return
    }
    if (
      !isViewportPresetActive?.() ||
      mouse.type !== 'mouseWheel' ||
      !canViewportScroll?.(mouse as Electron.MouseWheelInputEvent)
    ) {
      return
    }
    const { deltaX, deltaY } = mouse as Electron.MouseWheelInputEvent
    const safeDeltaX = typeof deltaX === 'number' && Number.isFinite(deltaX) ? deltaX : 0
    const safeDeltaY = typeof deltaY === 'number' && Number.isFinite(deltaY) ? deltaY : 0
    if (safeDeltaX === 0 && safeDeltaY === 0) {
      return
    }
    // Why: the host owns panning once emulation makes the guest viewport larger than the pane.
    event.preventDefault()
    onViewportWheelConsumed?.(safeDeltaX, safeDeltaY)
    resolveRenderer(browserTabId)?.send('ui:scrollBrowserPage', {
      browserPageId: browserTabId,
      deltaX: safeDeltaX,
      deltaY: safeDeltaY
    })
  }

  guest.on('before-mouse-event', handler)
  return () => {
    try {
      guest.off('before-mouse-event', handler)
    } catch {
      // Why: best-effort — guest may already be destroyed during teardown.
    }
  }
}
