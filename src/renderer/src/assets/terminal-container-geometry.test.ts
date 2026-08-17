import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')

describe('terminal container geometry', () => {
  it('keeps the hidden link tooltip out of the fitted terminal height', () => {
    expect(terminalCss).toMatch(/\.xterm-container\s*{[^}]*height:\s*100%;/s)
    expect(terminalCss).toMatch(
      /\.pane\[data-has-title\] \.xterm-container\s*{[^}]*height:\s*calc\(100% - var\(--orca-pane-title-height\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.pane-link-tooltip\s*{[^}]*height:\s*var\(--orca-terminal-link-tooltip-height\);/s
    )
  })

  it('insets the xterm grid on both axes from pane padding', () => {
    expect(terminalCss).toMatch(
      /\.xterm-container \.xterm\s*{[^}]*padding-top:\s*var\(--pane-padding-y, 4px\);/s
    )
    expect(terminalCss).toMatch(
      /\.xterm-container \.xterm\s*{[^}]*padding-right:\s*var\(--pane-padding-x, 4px\);/s
    )
    expect(terminalCss).toMatch(
      /\.xterm-container \.xterm\s*{[^}]*padding-bottom:\s*var\(--pane-padding-y, 4px\);/s
    )
    expect(terminalCss).toMatch(
      /\.xterm-container \.xterm\s*{[^}]*padding-left:\s*var\(--pane-padding-x, 4px\);/s
    )
    expect(terminalCss).toMatch(/\.xterm-container\s*{[^}]*width:\s*100%;/s)
    expect(terminalCss).not.toMatch(/\.xterm-container\s*{[^}]*margin-left:/s)
  })

  it('matches live DOM and WebGL background layers across translucent padding bands', () => {
    expect(terminalCss).toMatch(
      /\.xterm-container \.xterm::before\s*{[^}]*border-color:\s*var\(--orca-terminal-live-background, transparent\);/s
    )
    expect(terminalCss).toMatch(
      /\.xterm-container\[data-terminal-renderer='webgl'\] \.xterm::after\s*{[^}]*border-color:\s*var\(--orca-terminal-live-background, transparent\);/s
    )
  })
})
