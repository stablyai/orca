import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')

function getCssRuleBody(selector: string): string {
  const ruleMarker = mainCss.indexOf(`\n${selector} {`)
  expect(ruleMarker).toBeGreaterThanOrEqual(0)

  const ruleStart = ruleMarker + 1
  const bodyStart = mainCss.indexOf('{', ruleStart) + 1
  const bodyEnd = mainCss.indexOf('}', bodyStart)
  return mainCss.slice(bodyStart, bodyEnd)
}

describe('diff comment draft card shadow', () => {
  it('uses the documented shadow-xs tier instead of a hand-rolled fourth tier', () => {
    const draftCard = getCssRuleBody('.orca-diff-comment-inline > .orca-diff-comment-draft-card')

    // STYLEGUIDE.md caps elevation at border / shadow-xs / shadow-floating —
    // no invented per-component shadow values.
    expect(draftCard).toContain('shadow-xs')
    expect(draftCard).not.toMatch(/box-shadow:\s*\n?\s*0/)
    expect(draftCard).not.toContain('rgba(0, 0, 0,')
  })

  it('keeps the dark override at shadow-xs, not a hand-rolled or missing shadow', () => {
    const darkDraftCard = getCssRuleBody(
      '.dark .orca-diff-comment-inline > .orca-diff-comment-draft-card'
    )

    // Same selector specificity as `.dark .orca-diff-comment-popover` (its
    // ancestor via the shared draft-card component), which sits later in the
    // file — dropping this rule lets that popover's much larger floating
    // shadow win the cascade in dark mode instead of shadow-xs.
    expect(darkDraftCard).toContain('shadow-xs')
    expect(darkDraftCard).not.toContain('rgba(0, 0, 0,')
  })
})
