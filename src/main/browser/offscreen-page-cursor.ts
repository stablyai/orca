import type { NativeImage, Point } from 'electron'

// Electron's cursor-changed names that differ from the CSS keyword Chromium would show.
const CSS_BY_ELECTRON_TYPE: Record<string, string> = {
  pointer: 'default',
  hand: 'pointer',
  null: 'default',
  nodrop: 'no-drop',
  'drag-drop-none': 'no-drop',
  'drag-drop-move': 'move',
  'drag-drop-copy': 'copy',
  'drag-drop-link': 'alias',
  'm-panning': 'all-scroll',
  'm-panning-vertical': 'ns-resize',
  'm-panning-horizontal': 'ew-resize',
  'ns-no-resize': 'ns-resize',
  'ew-no-resize': 'ew-resize',
  'nesw-no-resize': 'nesw-resize',
  'nwse-no-resize': 'nwse-resize'
}

// Names Electron emits that are already CSS keywords.
const CSS_KEYWORDS = new Set([
  'crosshair',
  'text',
  'wait',
  'help',
  'e-resize',
  'n-resize',
  'ne-resize',
  'nw-resize',
  's-resize',
  'se-resize',
  'sw-resize',
  'w-resize',
  'ns-resize',
  'ew-resize',
  'nesw-resize',
  'nwse-resize',
  'col-resize',
  'row-resize',
  'move',
  'vertical-text',
  'cell',
  'context-menu',
  'alias',
  'progress',
  'copy',
  'none',
  'not-allowed',
  'zoom-in',
  'zoom-out',
  'grab',
  'grabbing'
])

/**
 * The CSS cursor for an offscreen page's `cursor-changed` event, so the canvas shows what the page
 * asked for. A page's own cursor image arrives as a bitmap and becomes an image-set at its scale.
 */
export function cssCursorForPage(
  type: string,
  image?: NativeImage,
  scale?: number,
  hotspot?: Point
): string {
  if (type === 'custom' && image && !image.isEmpty()) {
    const factor = scale && scale > 0 ? scale : 1
    // Why divide: CSS hotspots are in CSS px, the bitmap's are in its own pixels.
    const x = Math.round((hotspot?.x ?? 0) / factor)
    const y = Math.round((hotspot?.y ?? 0) / factor)
    return `image-set(url("${image.toDataURL()}") ${factor}x) ${x} ${y}, default`
  }
  if (type.endsWith('-panning')) {
    return `${type.slice(0, -'panning'.length)}resize`
  }
  return CSS_BY_ELECTRON_TYPE[type] ?? (CSS_KEYWORDS.has(type) ? type : 'default')
}
