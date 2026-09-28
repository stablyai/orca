import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')
const themeBlock = /@theme inline\s*{([\s\S]*?)\n}/.exec(mainCss)?.[1] ?? ''

// Why: a token that never reaches `@theme inline`, and a Tailwind-shaped name that is only a
// plain CSS selector, both generate no CSS at all -- the utility silently does nothing.
describe('main.css utility generation', () => {
  it('exposes --editor-surface to Tailwind so bg-editor-surface generates', () => {
    expect(mainCss).toMatch(/--editor-surface:/)
    expect(themeBlock).toMatch(/--color-editor-surface:\s*var\(--editor-surface\)/)
  })

  it('declares scrollbar-none as a utility rather than a plain class', () => {
    expect(mainCss).toMatch(/@utility scrollbar-none\s*{/)
    expect(mainCss).not.toMatch(/^\.scrollbar-none\b/m)
  })
})
