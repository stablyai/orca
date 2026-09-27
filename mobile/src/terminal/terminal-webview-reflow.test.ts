import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  documentModuleSource,
  documentSourceText
} from './document/document-module-source.test-support'

const DOCUMENT_SOURCE = documentSourceText()

// The reflow logic is the document's; the message dispatch and the handle wiring are the
// component's. Both are read as source, because the document is source now.
const reflowSource = documentModuleSource('reflow')
// The handle is built by the controller both components share, which is where the wiring is read.
const handleSource = readFileSync(
  new URL('./use-terminal-webview-controller.ts', import.meta.url),
  'utf8'
)

function reflowFnBody(): string {
  const start = reflowSource.indexOf('export function reflow(scope: TerminalDocumentScope')
  expect(start).toBeGreaterThanOrEqual(0)
  return reflowSource.slice(start)
}

describe('terminal WebView reflow', () => {
  it('skips the alternate screen so TUI snapshots are not mutated', () => {
    // Why: alt-screen snapshots are repainted by the PTY; a local resize there
    // can drop SGR attributes (white text). Reflow must early-return.
    expect(reflowFnBody()).toContain('if (!scope.term || isAlternateBufferActive(scope)) {')
  })

  it('rewraps the local buffer via term.resize to the new cols', () => {
    expect(reflowFnBody()).toContain('scope.term.resize(nextCols, nextRows)')
  })

  it('preserves the user scroll position across the rewrap', () => {
    const body = reflowFnBody()
    // At the live bottom -> stay pinned; scrolled up -> hold distance-from-bottom.
    expect(body).toContain('const wasAtBottom = buffer.viewportY >= buffer.baseY')
    expect(body).toContain('scope.term.scrollToBottom()')
    expect(body).toContain('rewrapped.baseY - distanceFromBottom - rewrapped.viewportY')
  })

  it('is no-op when the dimensions are unchanged', () => {
    expect(reflowFnBody()).toContain(
      'if (nextCols === scope.term.cols && nextRows === scope.term.rows) {'
    )
  })

  it('is dispatched by the reflow WebView message and exposed on the handle', () => {
    expect(DOCUMENT_SOURCE).toContain("} else if (msg.type === 'reflow') {")
    expect(DOCUMENT_SOURCE).toContain('reflow(scope, msg.cols!, msg.rows!)')
    expect(handleSource).toContain("postMessage({ type: 'reflow', cols, rows })")
  })

  it('does not locally resize hidden WebViews to a one-column grid', () => {
    // The floor is a constant of the module that fits the grid, and both readers import it.
    expect(DOCUMENT_SOURCE).toContain('export const MIN_FIT_COLS = 20')
    expect(DOCUMENT_SOURCE).toContain('if (cols < MIN_FIT_COLS) {')
    expect(DOCUMENT_SOURCE).toContain("flog(scope, 'measure-skip-small-width'")
    expect(DOCUMENT_SOURCE).toContain(
      "notify(scope, { type: 'measure-result', cols: null, rows: null })"
    )
  })
})
