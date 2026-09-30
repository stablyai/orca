import type { WebContents } from 'electron'
import type { OffscreenPageCaret } from '../../shared/offscreen-page-protocol'

/**
 * Where the page's text caret is, in the host renderer's CSS px, so the hidden IME textarea can
 * sit on it and the OS candidate window opens next to the text being composed.
 */
export async function readOffscreenPageCaret(
  contents: WebContents,
  hostZoomFactor: number
): Promise<OffscreenPageCaret | null> {
  const caret: unknown = await contents
    .executeJavaScript(READ_CARET_SCRIPT, false)
    .catch(() => null)
  if (!isCaret(caret)) {
    return null
  }
  // Page CSS px -> page DIPs -> the host renderer's CSS px.
  const scale = contents.getZoomFactor() / hostZoomFactor
  return { x: caret.x * scale, y: caret.y * scale, height: caret.height * scale }
}

const READ_CARET_SCRIPT = `(() => {
  const sel = document.getSelection()
  if (sel && sel.rangeCount) {
    const rects = sel.getRangeAt(0).getClientRects()
    const r = rects[rects.length - 1]
    if (r) return { x: r.left, y: r.top, height: r.height || 16 }
  }
  const el = document.activeElement
  if (el && el !== document.body && el.getBoundingClientRect) {
    const b = el.getBoundingClientRect()
    return { x: b.left + 4, y: b.top, height: b.height }
  }
  return null
})()`

function isCaret(value: unknown): value is OffscreenPageCaret {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('x' in value && 'y' in value && 'height' in value)) {
    return false
  }
  return [value.x, value.y, value.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}
