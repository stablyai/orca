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

  it('dims sleeping cards through theme tokens so the cue survives any surface', () => {
    const sleeping = getCssRuleBody('[data-worktree-sleeping-dim]')

    // Why oklab: a fixed perceptual step. An sRGB alpha over the painted backdrop
    // shrank as the surface lightened, so slept and awake read alike (#19624).
    expect(sleeping).toContain('in oklab')
    // Why token-anchored: the mix is defined by the theme's own foreground and
    // surface, so a custom background or tint scales it instead of cancelling it.
    expect(sleeping).toContain('var(--worktree-sidebar-foreground)')
    expect(sleeping).toContain('var(--worktree-sidebar)')
    // Why these two: title text and the muted lane (Moon, host badge) carry the cue.
    expect(sleeping).toContain('--foreground:')
    expect(sleeping).toContain('--muted-foreground:')
    // Why not opacity/filter: both dim toward the backdrop or strip themed hues.
    expect(sleeping).not.toContain('opacity:')
    expect(sleeping).not.toContain('filter:')
  })
})
