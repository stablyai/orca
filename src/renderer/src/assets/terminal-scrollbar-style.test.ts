import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const terminalCss = fs.readFileSync(new URL('./terminal.css', import.meta.url), 'utf8')
const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')

describe('terminal scrollbar styling', () => {
  it('reuses the canonical editor scrollbar with a transparent gutter', () => {
    expect(mainCss).toMatch(
      /\.scrollbar-editor,\s*\.xterm \.xterm-viewport\s*{[^}]*scrollbar-color:\s*rgba\(121, 121, 121, 0\.4\) transparent/s
    )
    expect(mainCss).toMatch(
      /\.scrollbar-editor::-webkit-scrollbar-track,\s*\.xterm \.xterm-viewport::-webkit-scrollbar-track\s*{[^}]*background:\s*transparent/s
    )
    expect(terminalCss).not.toContain('--xterm-scrollbar-thumb')
  })
})
