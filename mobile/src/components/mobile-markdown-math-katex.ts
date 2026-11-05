import katex from 'katex'
import { BoundedMap } from '../../../src/shared/bounded-map'
import { MARKDOWN_MATH_KATEX_SETTINGS } from '../../../src/shared/markdown-math-rules'
import { KATEX_PAGE_STYLE } from './katex-page-style.generated'

// Streaming replies re-render every formula above the growing tail; typeset each once.
const results = new BoundedMap<string, string | null>({
  maxEntries: 1000,
  maxBytes: 4 * 1024 * 1024,
  sizeOf: (html, key) => 256 + 2 * (key.length + (html?.length ?? 0))
})

let styleInstalled = false

function installKatexStyle(): void {
  if (styleInstalled) {
    return
  }
  styleInstalled = true
  const style = document.createElement('style')
  style.textContent = KATEX_PAGE_STYLE
  document.head.append(style)
}

/** KaTeX's HTML for a formula, or null when it does not parse; callers then show the source. */
export function typesetMobileMath(value: string, display: boolean): string | null {
  installKatexStyle()
  const key = `${display ? 'display' : 'inline'}:${value}`
  const cached = results.get(key)
  if (cached !== undefined) {
    return cached
  }
  let html: string | null
  try {
    html = katex.renderToString(value, {
      ...MARKDOWN_MATH_KATEX_SETTINGS,
      displayMode: display,
      throwOnError: true
    })
  } catch {
    html = null
  }
  results.set(key, html)
  return html
}
