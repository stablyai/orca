import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')
const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')

/** Split simple top-level `{...}` rule blocks (no nested rules in these selectors). */
function cssRuleBlocks(css: string): { selector: string; body: string }[] {
  const blocks: { selector: string; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(css)) !== null) {
    blocks.push({ selector: match[1].trim(), body: match[2] })
  }
  return blocks
}

function isViewportSelector(selector: string): boolean {
  // Matches ".xterm .xterm-viewport" alone or comma-listed, but not ::-webkit-scrollbar*
  return (
    /(?:^|,)\s*\.xterm\s+\.xterm-viewport\s*(?:,|$)/.test(selector) &&
    !selector.includes('::-webkit-scrollbar')
  )
}

describe('terminal scrollbar styling', () => {
  it('reuses the canonical editor scrollbar with a transparent gutter', () => {
    // Editor keeps standard scrollbar props for non-webkit engines.
    expect(mainCss).toMatch(
      /\.scrollbar-editor\s*{[^}]*scrollbar-color:\s*rgba\(121, 121, 121, 0\.4\) transparent/s
    )
    // Terminal viewport shares the webkit track/thumb (transparent gutter).
    expect(mainCss).toMatch(
      /\.scrollbar-editor::-webkit-scrollbar-track,\s*\.xterm \.xterm-viewport::-webkit-scrollbar-track\s*{[^}]*background:\s*transparent/s
    )
    expect(mainCss).toMatch(
      /\.scrollbar-editor::-webkit-scrollbar-thumb,\s*\.xterm \.xterm-viewport::-webkit-scrollbar-thumb\s*{[^}]*background:\s*rgba\(121, 121, 121, 0\.4\)/s
    )
    expect(terminalCss).not.toContain('--xterm-scrollbar-thumb')
  })

  // Why: Chromium (>=121) disables ::-webkit-scrollbar* when the element also
  // sets standard scrollbar-width/scrollbar-color. #7876 folded the viewport
  // into both rule sets; the custom thumb never painted (#12635).
  it('does not set standard scrollbar properties on the viewport that also uses webkit pseudos', () => {
    const hasWebkitViewport = /\.xterm\s+\.xterm-viewport::-webkit-scrollbar/.test(mainCss)
    expect(hasWebkitViewport).toBe(true)

    const conflicts = cssRuleBlocks(mainCss).filter(({ selector, body }) => {
      if (!isViewportSelector(selector)) {
        return false
      }
      return /\bscrollbar-width\s*:/.test(body) || /\bscrollbar-color\s*:/.test(body)
    })

    expect(conflicts).toEqual([])
  })
})
