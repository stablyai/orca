import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')
const HOVER_NONE_BLOCK = /@media \(hover: none\)\s*\{[\s\S]*?\}\s*\}/g

function selectorsRevealing(css: string, marker: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /opacity:\s*1\s*;/.test(body))
    .flatMap(([, selector]) => selector.split(','))
    .map((selector) => selector.replace(/\s+/g, ' ').trim())
    .filter((selector) => selector.includes(marker))
}

describe('terminal pane header buttons', () => {
  it('reveals active-pane buttons unconditionally only outside hover-only mode', () => {
    const selectors = selectorsRevealing(
      terminalCss.replace(HOVER_NONE_BLOCK, ''),
      '[data-active-pane]'
    )

    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector).toContain(".pane-title-overlay-layer:not([data-header-buttons='hover'])")
    }
  })

  it('keeps hover-only buttons visible on devices that cannot hover', () => {
    const hoverNone = terminalCss.match(HOVER_NONE_BLOCK)?.join('\n') ?? ''

    expect(selectorsRevealing(hoverNone, '[data-active-pane]')).toEqual([
      '.pane-title-bar[data-active-pane] .pane-title-split-trigger',
      '.pane-title-bar[data-active-pane] .pane-title-close'
    ])
  })
})
