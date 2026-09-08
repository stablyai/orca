import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./TerminalWebView.web.tsx', import.meta.url), 'utf8')
const rendererSource = readFileSync(
  new URL('./terminal-web-renderer-recovery.ts', import.meta.url),
  'utf8'
)

describe('hosted terminal runtime parity', () => {
  it('preserves reader position when a server reflow replays the snapshot', () => {
    expect(source).toContain('terminal.buffer.active.baseY - terminal.buffer.active.viewportY')
    expect(source).toContain(
      'terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - bottomOffset))'
    )
  })

  it('does not apply normal-buffer reflow semantics to alternate-screen TUIs', () => {
    expect(source).toContain("terminal?.buffer.active.type === 'normal'")
  })

  it('falls back after WebGL loss and limits recovery to one retry', () => {
    expect(rendererSource).toContain('next.onContextLoss')
    expect(rendererSource).toContain('attach(false)')
    expect(rendererSource).toContain('next?.dispose()')
    expect(rendererSource).toContain("document.visibilityState !== 'visible'")
  })
})
