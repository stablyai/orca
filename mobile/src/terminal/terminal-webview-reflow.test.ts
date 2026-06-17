import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'

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

  // Why: the raw-source assertions above pass even if the reflow module is
  // dropped from the XTERM_HTML concatenation (a broken/removed import or an
  // emptied TERMINAL_REFLOW_JS leaves the `${...}` placeholder in the template
  // but never injects the routine). That was the regression class reported when
  // a sibling refactor extracted the tap dispatcher next to the reflow inject.
  // Guard the *assembled* document so the routine and its dispatch are really
  // present in what the WebView runs.
  describe('assembled XTERM_HTML', () => {
    it('still injects the reflow routine (placeholder fully expanded)', () => {
      expect(XTERM_HTML).toContain('function reflow(cols, rows) {')
      expect(XTERM_HTML).toContain('term.resize(nextCols, nextRows);')
      // No unexpanded template placeholder for the injected reflow JS.
      expect(XTERM_HTML).not.toContain('TERMINAL_REFLOW_JS}')
    })

    it('still routes the reflow message to the injected routine', () => {
      expect(XTERM_HTML).toContain("} else if (msg.type === 'reflow') {")
      expect(XTERM_HTML).toContain('reflow(msg.cols, msg.rows);')
    })

    it('still wires the message listener after the reflow routine and tap dispatcher', () => {
      // Why: the reflow message only reaches reflow() if the document-level
      // message listener actually attaches. The tap dispatcher is injected
      // between them; if its IIFE-time code threw, the listener below would
      // never bind and reflow messages would silently no-op.
      const reflowAt = XTERM_HTML.indexOf('function reflow(cols, rows) {')
      const dispatchAt = XTERM_HTML.indexOf("var dispatch = { mode: 'idle'")
      const listenerAt = XTERM_HTML.indexOf("window.addEventListener('message'")
      expect(reflowAt).toBeGreaterThanOrEqual(0)
      expect(dispatchAt).toBeGreaterThan(reflowAt)
      expect(listenerAt).toBeGreaterThan(dispatchAt)
    })
  })
})
