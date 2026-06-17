import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The reflow logic lives as injected in-WebView JS; the message dispatch and
// handle wiring live in terminal-webview-html.ts / TerminalWebView.tsx. Assert
// the load-bearing invariants from source, mirroring the other tests here.
const reflowSource = readFileSync(
  new URL('./terminal-webview-reflow-injected.ts', import.meta.url),
  'utf8'
)
const htmlSource = readFileSync(new URL('./terminal-webview-html.ts', import.meta.url), 'utf8')
const handleSource = readFileSync(new URL('./TerminalWebView.tsx', import.meta.url), 'utf8')

function reflowFnBody(): string {
  const start = reflowSource.indexOf('function reflow(cols, rows) {')
  expect(start).toBeGreaterThanOrEqual(0)
  return reflowSource.slice(start)
}

describe('terminal WebView reflow', () => {
  it('skips the alternate screen so TUI snapshots are not mutated', () => {
    // Why: alt-screen snapshots are repainted by the PTY; a local resize there
    // can drop SGR attributes (white text). Reflow must early-return.
    expect(reflowFnBody()).toContain('if (!term || isAlternateBufferActive()) return;')
  })

  it('rewraps the local buffer via term.resize to the new cols', () => {
    expect(reflowFnBody()).toContain('term.resize(nextCols, nextRows);')
  })

  it('preserves the user scroll position across the rewrap', () => {
    const body = reflowFnBody()
    // At the live bottom -> stay pinned; scrolled up -> hold distance-from-bottom.
    expect(body).toContain('var wasAtBottom = buffer.viewportY >= buffer.baseY;')
    expect(body).toContain('term.scrollToBottom();')
    expect(body).toContain('rewrapped.baseY - distanceFromBottom - rewrapped.viewportY')
  })

  it('is no-op when the dimensions are unchanged', () => {
    expect(reflowFnBody()).toContain(
      'if (nextCols === term.cols && nextRows === term.rows) return;'
    )
  })

  it('is dispatched by the reflow WebView message and exposed on the handle', () => {
    expect(htmlSource).toContain("} else if (msg.type === 'reflow') {")
    expect(htmlSource).toContain('reflow(msg.cols, msg.rows);')
    expect(handleSource).toContain("postMessage({ type: 'reflow', cols, rows })")
  })
})
