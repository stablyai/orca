import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')

describe('terminal container geometry', () => {
  it('keeps the hidden link tooltip out of the fitted terminal height', () => {
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*height:\s*calc\(100% - var\(--pane-padding-y, 4px\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.pane\[data-has-title\] \.xterm-container\s*{[^}]*height:\s*calc\(100% - var\(--orca-pane-title-height\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.pane-link-tooltip\s*{[^}]*height:\s*var\(--orca-terminal-link-tooltip-height\);/s
    )
  })

  it('caps and centers an unsplit tab, and only while the pane is the only child', () => {
    expect(terminalCss).toMatch(
      /\[data-retained-pane-host\] \[data-terminal-tab-id\]:not\(\[data-terminal-chat-view\]\) > \.pane:only-child\s*{[^}]*max-width:\s*var\(--pane-single-max-width, 1100px\);[^}]*margin-inline:\s*auto;[^}]*border-inline:\s*var\(--pane-single-edge-width, 1px\)/s
    )
  })

  it('bounds cursor-blink repaints to the terminal surface (#10481)', () => {
    expect(terminalCss).toMatch(/\.xterm-container\s*{[^}]*contain:\s*paint;/s)
  })
})
