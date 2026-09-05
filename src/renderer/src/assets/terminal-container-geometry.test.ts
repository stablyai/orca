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

  it('pins the terminal grid to the container bottom so fit slack sits above row one', () => {
    // Unprefixed: floating-workspace terminals mount outside .pane-manager-root.
    expect(terminalCss).toMatch(/^\.xterm-container\s*{[^}]*justify-content:\s*flex-end;/ms)
    expect(terminalCss).not.toMatch(/\.pane-manager-root \.xterm\s*{[^}]*height:\s*100%;/s)
  })
})
