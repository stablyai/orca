import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generatedDocumentModule } from './document/generated-document-region.test-support'
import { XTERM_HTML } from './terminal-webview-html'

// The reflow logic runs inside the WebView document; the message dispatch and handle wiring live
// in terminal-webview-html.ts / TerminalWebView.tsx. Assert the load-bearing invariants from the
// document the WebView runs, mirroring the other tests here.
const reflowSource = await generatedDocumentModule('reflow')
// Use the assembled document so the test covers what the WebView actually runs.
const htmlSource = XTERM_HTML
// The handle is built by the controller both components share, which is where the wiring is read.
const handleSource = readFileSync(
  new URL('./use-terminal-webview-controller.ts', import.meta.url),
  'utf8'
)

function reflowFnBody(): string {
  const start = reflowSource.indexOf('function reflow(cols, rows) {')
  expect(start).toBeGreaterThanOrEqual(0)
  return reflowSource.slice(start)
}

describe('terminal WebView reflow', () => {
  it('skips the alternate screen so TUI snapshots are not mutated', () => {
    // Why: alt-screen snapshots are repainted by the PTY; a local resize there
    // can drop SGR attributes (white text). Reflow must early-return.
    expect(reflowFnBody()).toContain('if (!scope.term || isAlternateBufferActive()) {')
  })

  it('rewraps the local buffer via term.resize to the new cols', () => {
    expect(reflowFnBody()).toContain('scope.term.resize(nextCols, nextRows);')
  })

  it('preserves the user scroll position across the rewrap', () => {
    const body = reflowFnBody()
    // At the live bottom -> stay pinned; scrolled up -> hold distance-from-bottom.
    expect(body).toContain('const wasAtBottom = buffer.viewportY >= buffer.baseY;')
    expect(body).toContain('scope.term.scrollToBottom();')
    expect(body).toContain('rewrapped.baseY - distanceFromBottom - rewrapped.viewportY')
  })

  it('is no-op when the dimensions are unchanged', () => {
    expect(reflowFnBody()).toContain(
      'if (nextCols === scope.term.cols && nextRows === scope.term.rows) {'
    )
  })

  it('is dispatched by the reflow WebView message and exposed on the handle', () => {
    expect(htmlSource).toContain('} else if (msg.type === "reflow") {')
    expect(htmlSource).toContain('reflow(msg.cols, msg.rows);')
    expect(handleSource).toContain("postMessage({ type: 'reflow', cols, rows })")
  })

  it('does not locally resize hidden WebViews to a one-column grid', () => {
    // Ruling 21: the floor's value is in the scope factory, not in a parse-time write.
    expect(htmlSource).toContain('MIN_FIT_COLS: 20,')
    expect(htmlSource).toContain('if (cols < scope.MIN_FIT_COLS) {')
    expect(htmlSource).toContain('flog("measure-skip-small-width"')
    expect(htmlSource).toContain('notify({ type: "measure-result", cols: null, rows: null });')
  })

  // Why: the assertions above read the reflow module's own emission, which still reads whole if
  // the generator drops the module from the document or emits it twice. That was the regression
  // class reported when a sibling refactor extracted the tap dispatcher next to reflow. Guard the
  // assembled document so the routine, once, and its dispatch are really in what the WebView runs.
  describe('assembled XTERM_HTML', () => {
    it('carries the reflow routine exactly once', () => {
      expect(XTERM_HTML).toContain('function reflow(cols, rows) {')
      expect(XTERM_HTML).toContain('scope.term.resize(nextCols, nextRows);')
      expect(XTERM_HTML.split(reflowSource).length - 1).toBe(1)
    })

    it('still routes the reflow message to the injected routine', () => {
      expect(XTERM_HTML).toContain('} else if (msg.type === "reflow") {')
      expect(XTERM_HTML).toContain('reflow(msg.cols, msg.rows);')
    })

    it('still wires the message listener after the reflow routine and tap dispatcher', () => {
      // Why: the reflow message only reaches reflow() if the document-level
      // message listener actually attaches. The tap dispatcher is injected
      // between them; if its IIFE-time code threw, the listener below would
      // never bind and reflow messages would silently no-op.
      const reflowAt = XTERM_HTML.indexOf('function reflow(cols, rows) {')
      // Ruling 21 moved the dispatcher's latch onto the scope, so the dispatcher is located by
      // its own first handler rather than by the object it used to declare.
      const dispatchAt = XTERM_HTML.indexOf('function onDocumentTouchStart(e) {')
      const listenerAt = XTERM_HTML.indexOf('window.addEventListener("message"')
      expect(reflowAt).toBeGreaterThanOrEqual(0)
      expect(dispatchAt).toBeGreaterThan(reflowAt)
      expect(listenerAt).toBeGreaterThan(dispatchAt)
    })
  })
})
