import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, type Rgba } from '../lib/plugin-theme-tokens'

const css = readFileSync(new URL('./main.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

/** Last-wins hex tokens from every top-level block whose selector list starts with `selector`. */
function themeTokens(selector: ':root' | '.dark'): Map<string, Rgba> {
  const tokens = new Map<string, Rgba>()
  for (const [, selectors, body] of css.matchAll(/(?:^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g)) {
    if (selectors.trim().split(/\s*,\s*/)[0] !== selector) {
      continue
    }
    for (const [, name, hex] of body.matchAll(/(--[\w-]+):\s*#([0-9a-f]{3}|[0-9a-f]{6});/gi)) {
      const digits = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex
      const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16))
      tokens.set(name, [r, g, b, 1])
    }
  }
  return tokens
}

function tint(color: Rgba, amount: number, surface: Rgba): Rgba {
  const [r, g, b] = [0, 1, 2].map((i) => color[i] * amount + surface[i] * (1 - amount))
  return [r, g, b, 1]
}

const successTint = Number(
  css.match(/--status-success-background: color-mix\(in srgb, var\(--status-success\) (\d+)%/)?.[1]
)

describe.each([':root', '.dark'] as const)('built-in %s token pairs', (selector) => {
  const tokens = themeTokens(selector)
  const token = (name: string): Rgba => {
    const value = tokens.get(name)
    if (!value) {
      throw new Error(`${name} is not a hex color in ${selector}`)
    }
    return value
  }

  it.each([
    ['--destructive-foreground', '--destructive'],
    ['--muted-foreground', '--background'],
    ['--muted-foreground', '--muted'],
    ['--muted-foreground', '--accent'],
    ['--muted-foreground', '--card']
  ])('%s on %s meets WCAG AA', (text, surface) => {
    expect(contrastRatio(token(text), token(surface))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['--background', '--muted'])('success text on its tint over %s meets WCAG AA', (name) => {
    const surface = tint(token('--status-success'), successTint / 100, token(name))
    expect(contrastRatio(token('--status-success'), surface)).toBeGreaterThanOrEqual(4.5)
  })
})
