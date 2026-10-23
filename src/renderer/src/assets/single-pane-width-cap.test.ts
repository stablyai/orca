import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')

// Why: upstream removed terminal-container-geometry.test.ts; these are the single-pane cap's own checks.
describe('single-pane width cap', () => {
  it('caps and centers an unsplit tab, and only while the pane is the only child', () => {
    expect(terminalCss).toMatch(
      /\[data-retained-pane-host\]\[data-tab-area-unsplit\]\s+\[data-terminal-tab-id\]:not\(\[data-terminal-chat-view\]\)\s*>\s*\.pane:only-child\s*{[^}]*max-width:\s*var\(--pane-single-max-width, 1100px\);[^}]*margin-inline:\s*auto;[^}]*border-inline:\s*var\(--pane-single-edge-width, 1px\)/s
    )
  })

  it('lifts the cap once the tab area is split, so a side-by-side pane fills its half', () => {
    // The selector requires the attribute; a split host simply stops matching.
    expect(terminalCss).not.toMatch(/\[data-retained-pane-host\] \[data-terminal-tab-id\]/)
  })

  it('caps editor and markdown content with the same shared width', () => {
    expect(terminalCss).toMatch(
      /\[data-tab-area-unsplit\][^{]*\.pane-single-cap[^{]*{[^}]*max-width:\s*var\(--pane-single-max-width, 1100px\);[^}]*margin-inline:\s*auto;/s
    )
  })

})
