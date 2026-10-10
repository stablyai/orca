import { Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions, WebContents } from 'electron'
import type {
  OffscreenPageSelectAnchor,
  OffscreenPageUserInput
} from '../../shared/offscreen-page-protocol'

// Why an isolated world: the page must not see or tamper with the element Orca stashes.
const SELECT_POPUP_WORLD_ID = 1209
// Keys that open a focused <select>'s menu on some platform.
const SELECT_OPENING_KEYS = new Set([' ', 'Enter', 'ArrowDown', 'ArrowUp', 'F4'])

export type OffscreenPageSelectItem = {
  label: string
  /** The option's index in the select, or null for an optgroup heading. */
  index: number | null
  disabled: boolean
}

export type OffscreenPageSelectPopup = {
  items: OffscreenPageSelectItem[]
  selectedIndex: number
  /** The select's border box in page CSS px. */
  anchor: OffscreenPageSelectAnchor
}

/** Whether this user input can have left a <select> open. */
export function mayOpenOffscreenPageSelect(input: OffscreenPageUserInput): boolean {
  return (
    (input.kind === 'mouse' && input.type === 'mouseUp') ||
    (input.kind === 'key' && input.type === 'keyDown' && SELECT_OPENING_KEYS.has(input.key))
  )
}

/** The select's anchor in the host renderer's CSS px, relative to the page element. */
export function toHostSelectAnchor(
  popup: OffscreenPageSelectPopup,
  contents: WebContents,
  hostZoomFactor: number
): OffscreenPageSelectAnchor {
  const scale = contents.getZoomFactor() / hostZoomFactor
  const { x, y, width, height } = popup.anchor
  return { x: x * scale, y: y * scale, width: width * scale, height: height * scale }
}

/**
 * The open <select> in the page, if any. On macOS Blink hands select menus to the platform, and an
 * offscreen page has no native view to show one, so the select sits "open" and invisible until
 * Orca draws the menu itself.
 */
export async function readOpenOffscreenPageSelect(
  contents: WebContents
): Promise<OffscreenPageSelectPopup | null> {
  const value: unknown = await contents
    .executeJavaScriptInIsolatedWorld(SELECT_POPUP_WORLD_ID, [{ code: READ_OPEN_SELECT_SCRIPT }])
    .catch(() => null)
  return isSelectPopup(value) ? value : null
}

/**
 * Shows the select's options as a native menu anchored at `point` (window DIPs). Closing the menu
 * clicks the select again, the one input that makes Blink drop its invisible open state; a pick
 * then sets the value and fires the events a real choice fires.
 */
export function showOffscreenPageSelectMenu(args: {
  contents: WebContents
  window: BrowserWindow
  popup: OffscreenPageSelectPopup
  point: { x: number; y: number }
  /** Page DIPs per page CSS px; converts the anchor for the closing click. */
  pageZoomFactor: number
}): void {
  const { contents, popup, pageZoomFactor } = args
  const template = popup.items.map((item): MenuItemConstructorOptions => {
    const { index } = item
    if (index === null) {
      return { label: item.label, enabled: false }
    }
    return {
      label: item.label,
      type: 'checkbox',
      checked: index === popup.selectedIndex,
      enabled: !item.disabled,
      click: () => void runInSelectWorld(contents, buildChooseScript(index))
    }
  })
  const positioningItem = popup.items.findIndex((item) => item.index === popup.selectedIndex)
  Menu.buildFromTemplate(template).popup({
    window: args.window,
    x: Math.round(args.point.x),
    y: Math.round(args.point.y),
    positioningItem: positioningItem !== -1 ? positioningItem : undefined,
    callback: () => {
      if (contents.isDestroyed()) {
        return
      }
      void runInSelectWorld(contents, IS_STASHED_SELECT_OPEN_SCRIPT).then((open) => {
        if (open !== true || contents.isDestroyed()) {
          return
        }
        const x = Math.round((popup.anchor.x + popup.anchor.width / 2) * pageZoomFactor)
        const y = Math.round((popup.anchor.y + popup.anchor.height / 2) * pageZoomFactor)
        for (const type of ['mouseDown', 'mouseUp'] as const) {
          contents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
        }
      })
    }
  })
}

function runInSelectWorld(contents: WebContents, code: string): Promise<unknown> {
  if (contents.isDestroyed()) {
    return Promise.resolve(null)
  }
  return contents
    .executeJavaScriptInIsolatedWorld(SELECT_POPUP_WORLD_ID, [{ code }])
    .catch(() => null)
}

const READ_OPEN_SELECT_SCRIPT = `(() => {
  let select = null
  try { select = document.querySelector('select:open') } catch { return null }
  if (!select || select.multiple) return null
  window.__orcaOpenSelect = select
  const items = []
  const pushOption = (option, groupDisabled) => {
    if (option instanceof HTMLOptionElement && !option.hidden) {
      items.push({ label: option.label || option.text, index: option.index, disabled: option.disabled || groupDisabled })
    }
  }
  for (const child of select.children) {
    if (child instanceof HTMLOptGroupElement) {
      items.push({ label: child.label, index: null, disabled: true })
      for (const option of child.children) pushOption(option, child.disabled)
    } else {
      pushOption(child, false)
    }
  }
  const r = select.getBoundingClientRect()
  return { items, selectedIndex: select.selectedIndex, anchor: { x: r.left, y: r.top, width: r.width, height: r.height } }
})()`

const IS_STASHED_SELECT_OPEN_SCRIPT = `(() => {
  const select = window.__orcaOpenSelect
  try { return Boolean(select && select.isConnected && select.matches(':open')) } catch { return false }
})()`

function buildChooseScript(index: number): string {
  return `(() => {
  const select = window.__orcaOpenSelect
  if (!select || !select.isConnected || select.selectedIndex === ${index}) return
  select.selectedIndex = ${index}
  select.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
})()`
}

function isSelectPopup(value: unknown): value is OffscreenPageSelectPopup {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('items' in value && 'selectedIndex' in value && 'anchor' in value)) {
    return false
  }
  return (
    Array.isArray(value.items) &&
    value.items.every(isSelectItem) &&
    typeof value.selectedIndex === 'number' &&
    isAnchor(value.anchor)
  )
}

function isSelectItem(value: unknown): value is OffscreenPageSelectItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'label' in value &&
    'index' in value &&
    'disabled' in value &&
    typeof value.label === 'string' &&
    (value.index === null || Number.isInteger(value.index)) &&
    typeof value.disabled === 'boolean'
  )
}

function isAnchor(value: unknown): value is OffscreenPageSelectAnchor {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('x' in value && 'y' in value && 'width' in value && 'height' in value)) {
    return false
  }
  return [value.x, value.y, value.width, value.height].every(
    (n) => typeof n === 'number' && Number.isFinite(n)
  )
}
