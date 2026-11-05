import { MARKDOWN_MATH_KATEX_SETTINGS } from '../../../src/shared/markdown-math-rules'
import { KATEX_PAGE_STYLE } from './katex-page-style.generated'
import type { MobileMathTypesetter } from './mobile-markdown-math-typesetter'

// Streaming replies re-render every formula above the growing tail; typeset each once.
const MAX_CACHED_FORMULAS = 500
const results = new Map<string, string | null>()

/** KaTeX loads with the first formula a page shows, from the chunk mermaid also uses. */
export async function loadMobileMathTypesetter(): Promise<MobileMathTypesetter | null> {
  const { default: katex } = await import('katex')
  const style = document.createElement('style')
  style.textContent = KATEX_PAGE_STYLE
  document.head.append(style)
  return (value, display) => {
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
      // Like desktop, a formula KaTeX can't parse stays as its source.
      html = null
    }
    if (results.size >= MAX_CACHED_FORMULAS) {
      results.clear()
    }
    results.set(key, html)
    return html
  }
}
