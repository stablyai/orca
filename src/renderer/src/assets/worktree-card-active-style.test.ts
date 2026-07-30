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

describe('worktree card active styling', () => {
  it('keeps the primary selection wash translucent so card text stays legible', () => {
    const primary = getCssRuleBody(
      "[data-worktree-card-surface][data-worktree-card-active='primary']"
    )
    const darkPrimary = getCssRuleBody(
      ".dark [data-worktree-card-surface][data-worktree-card-active='primary']"
    )

    expect(primary).toContain(
      'background: color-mix(in srgb, var(--worktree-sidebar-foreground) 8%, transparent)'
    )
    expect(darkPrimary).toContain(
      'background: color-mix(in srgb, var(--worktree-sidebar-foreground) 10%, transparent)'
    )
    expect(darkPrimary).toContain('var(--worktree-sidebar-border)')
  })

  it('keeps the secondary selection ring when CSS owns the active state', () => {
    const secondary = getCssRuleBody(
      "[data-worktree-card-surface][data-worktree-card-active='secondary']"
    )
    const darkSecondary = getCssRuleBody(
      ".dark [data-worktree-card-surface][data-worktree-card-active='secondary']"
    )

    expect(secondary).toContain('var(--sidebar-ring) 15%')
    expect(darkSecondary).toContain('var(--sidebar-ring) 18%')
  })
})
