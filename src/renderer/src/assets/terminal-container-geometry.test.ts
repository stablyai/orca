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

  it('balances horizontal padding across both edges of the terminal container', () => {
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*width:\s*calc\(100% - var\(--pane-padding-x, 4px\) \* 2\);/s
    )
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*margin-left:\s*var\(--pane-padding-x, 4px\);/s
    )
    expect(terminalCss).toMatch(
      /\.xterm-container\s*{[^}]*margin-right:\s*var\(--pane-padding-x, 4px\);/s
    )
  })
})
