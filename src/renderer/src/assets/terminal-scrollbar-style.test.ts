import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')

describe('terminal scrollbar styling', () => {
  it('keeps the reserved xterm viewport scrollbar gutter transparent', () => {
    expect(terminalCss).toMatch(
      /\.xterm \.xterm-viewport\s*{[^}]*scrollbar-color:\s*var\(--xterm-scrollbar-thumb\) transparent/s
    )
    expect(terminalCss).toMatch(
      /\.xterm \.xterm-viewport::-webkit-scrollbar-track\s*{[^}]*background:\s*transparent/s
    )
  })
})
