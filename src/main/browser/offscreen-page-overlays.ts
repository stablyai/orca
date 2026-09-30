import { nativeTheme } from 'electron'
import type { NativeImage, Rectangle } from 'electron'
import type {
  OffscreenPageDatalist,
  OffscreenPageDatalistItem,
  OffscreenPageUserInput
} from '../../shared/offscreen-page-protocol'
import { OFFSCREEN_PAGE_GUEST_CHANNELS } from '../../shared/offscreen-page-guest-channels'
import { cssCursorForPage } from './offscreen-page-cursor'
import {
  createOffscreenPageDatalistMirror,
  type OffscreenPageDatalistPopup
} from './offscreen-page-datalist'
import type { OffscreenPageSurface } from './offscreen-page-surface'
import { sendOffscreenPageMouse } from './offscreen-page-user-input'

/** Renderer channels, each sent with the page id first. */
export const OFFSCREEN_PAGE_CURSOR_CHANNEL = 'offscreen-page:cursor'
export const OFFSCREEN_PAGE_TOOLTIP_CHANGED_CHANNEL = 'offscreen-page:tooltip-changed'
export const OFFSCREEN_PAGE_DATALIST_CHANNEL = 'offscreen-page:datalist'

// Why 1024: Chromium truncates tooltips to that length before showing them.
const MAX_TOOLTIP = 1024
const MAX_DATALIST_ITEMS = 512
const MAX_DATALIST_TEXT = 1024

// Electron's accelerator names for the keys the datalist popup handles.
const POPUP_KEY_CODES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
  Enter: 'Return',
  Tab: 'Tab'
}

export type OffscreenPageOverlays = {
  /** Feeds a paint that carried no texture. */
  onBitmapPaint(dirty: Rectangle, image: NativeImage): void
  /** Sends input the page's own popup must take; true when it did, so the caller skips it. */
  routeInput(input: OffscreenPageUserInput): boolean
}

/**
 * The page UI Chromium would draw outside the page's pixels (cursor, tooltip, datalist popup),
 * which an offscreen page never shows. Orca draws each over the page instead.
 */
export function createOffscreenPageOverlays(args: {
  surface: OffscreenPageSurface
  /** Sends to the renderer showing the page. */
  send: (channel: string, payload: unknown) => void
  /** Page DIPs per host CSS px. */
  hostZoomFactor: () => number
}): OffscreenPageOverlays {
  const { surface, send } = args
  const { contents } = surface

  contents.on('cursor-changed', (_event, type, image, scale, _size, hotspot) => {
    send(OFFSCREEN_PAGE_CURSOR_CHANNEL, cssCursorForPage(type, image, scale, hotspot))
  })

  let tooltip = ''
  contents.ipc.on(OFFSCREEN_PAGE_GUEST_CHANNELS.tooltip, (_event, text: unknown) => {
    const next = typeof text === 'string' ? text.slice(0, MAX_TOOLTIP) : ''
    if (next !== tooltip) {
      tooltip = next
      send(OFFSCREEN_PAGE_TOOLTIP_CHANGED_CHANNEL, tooltip)
    }
  })

  const datalist = createOffscreenPageDatalistMirror({
    scaleFactor: surface.scaleFactor,
    queryItems: () => {
      for (const frame of contents.mainFrame.framesInSubtree) {
        frame.send(OFFSCREEN_PAGE_GUEST_CHANNELS.datalistQuery)
      }
    },
    onChange: (popup) => send(OFFSCREEN_PAGE_DATALIST_CHANNEL, toHostDatalist(popup))
  })
  const toHostDatalist = (
    popup: OffscreenPageDatalistPopup | null
  ): OffscreenPageDatalist | null => {
    if (!popup) {
      return null
    }
    const scale = 1 / args.hostZoomFactor()
    const { x, y, width, height } = popup.rect
    return {
      rect: { x: x * scale, y: y * scale, width: width * scale, height: height * scale },
      scale,
      items: popup.items,
      selected: popup.selected,
      dark: nativeTheme.shouldUseDarkColors
    }
  }
  contents.ipc.on(OFFSCREEN_PAGE_GUEST_CHANNELS.datalistItems, (_event, items: unknown) => {
    datalist.setItems(readDatalistItems(items))
  })

  return {
    onBitmapPaint(dirty, image) {
      datalist.onBitmapPaint(dirty, image.isEmpty(), surface.size())
    },
    routeInput(input) {
      if (!datalist.onUserInput(input) || contents.isDestroyed()) {
        return false
      }
      if (input.kind === 'mouse') {
        sendOffscreenPageMouse(contents, input)
        return true
      }
      if (input.kind !== 'key') {
        return false
      }
      // Why sendInputEvent: only it passes the popup's key hook; CDP keys go straight to the page.
      contents.sendInputEvent({
        type: input.type === 'keyDown' ? 'keyDown' : 'keyUp',
        keyCode: POPUP_KEY_CODES[input.key] ?? input.key,
        modifiers: [...input.modifiers]
      })
      return true
    }
  }
}

function readDatalistItems(raw: unknown): OffscreenPageDatalistItem[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.slice(0, MAX_DATALIST_ITEMS).flatMap((item: unknown) => {
    const value: unknown =
      typeof item === 'object' && item !== null ? Reflect.get(item, 'value') : null
    const label: unknown =
      typeof item === 'object' && item !== null ? Reflect.get(item, 'label') : null
    return typeof value === 'string' && typeof label === 'string'
      ? [{ value: value.slice(0, MAX_DATALIST_TEXT), label: label.slice(0, MAX_DATALIST_TEXT) }]
      : []
  })
}
