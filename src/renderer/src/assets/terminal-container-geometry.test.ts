import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')

describe('terminal container geometry', () => {
  it('keeps the hidden link tooltip out of the fitted terminal height', () => {
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*height:\s*calc\(100% - \(2 \* var\(--pane-padding-y, 4px\)\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.pane\[data-has-title\] \.xterm-container\s*{[^}]*height:\s*calc\(100% - var\(--orca-pane-title-height\) - \(2 \* var\(--pane-padding-y, 4px\)\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.pane-link-tooltip\s*{[^}]*height:\s*var\(--orca-terminal-link-tooltip-height\);/s
    )
  })

  // Why: #13252 — Padding X/Y must inset both axes; start-only margins left right/bottom flush.
  it('insets the xterm grid on both axes from pane padding', () => {
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*width:\s*calc\(100% - \(2 \* var\(--pane-padding-x, 4px\)\)\);/s
    )
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*margin-top:\s*var\(--pane-padding-y, 4px\);/s
    )
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*margin-left:\s*var\(--pane-padding-x, 4px\);/s
    )
    expect(terminalCss).toMatch(
      /\.pane\[data-has-title\] \.xterm-container\s*{[^}]*margin-top:\s*calc\(var\(--orca-pane-title-height\) \+ var\(--pane-padding-y, 4px\)\);/s
    )
  })
})
