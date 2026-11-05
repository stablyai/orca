import { BoundedMap } from '../../../src/shared/bounded-map'
import { MARKDOWN_MATH_KATEX_SETTINGS } from '../../../src/shared/markdown-math-rules'
import { markdownMathSelectionText } from '../../../src/shared/markdown-math-selection'
import { KATEX_PAGE_STYLE } from './katex-page-style.generated'
import { GITHUB_MATH_SIZE_MACROS } from './mobile-markdown-math-nodes'
import type { MobileMathTypesetter } from './mobile-markdown-math-typesetter'

// Streaming replies re-render every formula above the growing tail; typeset each once, within the
// same count and byte bounds as desktop chat's cache.
const results = new BoundedMap<string, string | null>({
  maxEntries: 1000,
  maxBytes: 4 * 1024 * 1024,
  sizeOf: (html, key) => 256 + 2 * (key.length + (html?.length ?? 0))
})

/** KaTeX loads with the first formula a page shows, from the chunk mermaid also uses. */
export async function loadMobileMathTypesetter(): Promise<MobileMathTypesetter | null> {
  const { default: katex } = await import('katex')
  const style = document.createElement('style')
  // Inline math takes its height from KaTeX's struts alone, so a size command (the PR line-count
  // table's glyphs) keeps its line at text height and on the text's baseline, as on GitHub.
  style.textContent = `${KATEX_PAGE_STYLE}:not(.katex-display)>.katex{line-height:0}`
  document.head.append(style)
  // Like desktop chat, a copied selection carries each formula once, as its TeX.
  document.addEventListener('copy', (event) => {
    const selection = document.getSelection()
    const text = selection && markdownMathSelectionText(selection, document.body)
    if (event.defaultPrevented || text === null || !event.clipboardData) {
      return
    }
    event.clipboardData.setData('text/plain', text)
    event.clipboardData.setData('text/html', '')
    event.preventDefault()
  })
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
        // A copy: KaTeX writes \gdef definitions into the object it is given.
        macros: { ...GITHUB_MATH_SIZE_MACROS },
        displayMode: display,
        throwOnError: true
      })
    } catch {
      // Like desktop, a formula KaTeX can't parse stays as its source.
      html = null
    }
    results.set(key, html)
    return html
  }
}
