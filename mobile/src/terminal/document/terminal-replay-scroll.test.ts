// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import type { TerminalDocumentTerminal } from './document-terminal-shape'
import { handleMsg } from './host-message-router'
import { afterWritesDrained } from './write-queue'

const scopes: TerminalDocumentScope[] = []

function createReplayHarness() {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
  const terminals: Terminal[] = []
  const scope = createTerminalDocumentScope({
    hasEngine: () => true,
    installHostTransport: () => () => {},
    createTerminal: (options) => {
      const terminal = new Terminal({
        cols: typeof options.cols === 'number' ? options.cols : 80,
        rows: typeof options.rows === 'number' ? options.rows : 24,
        scrollback: 5000,
        allowProposedApi: true
      })
      terminals.push(terminal)
      // Exercise xterm's real parser and viewport without requiring a canvas renderer.
      const documentTerminal = terminalDocumentDouble().terminal
      return {
        ...documentTerminal,
        get cols() {
          return terminal.cols
        },
        get rows() {
          return terminal.rows
        },
        get buffer() {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's own buffer; only getCell's cell parameter is narrower in the document shape, as in terminal-web-document-mount.ts.
          return terminal.buffer as unknown as TerminalDocumentTerminal['buffer']
        },
        write: (data, callback) => terminal.write(data, callback),
        reset: () => terminal.reset(),
        resize: (cols, rows) => terminal.resize(cols, rows),
        scrollToLine: (line) => terminal.scrollToLine(line),
        scrollLines: (lines) => terminal.scrollLines(lines),
        scrollToBottom: () => terminal.scrollToBottom(),
        dispose: () => terminal.dispose()
      }
    },
    createUnicode11Addon: () => null,
    createWebglAddon: () => null,
    postToHost: () => {}
  })
  startTerminalDocument(scope)
  scopes.push(scope)

  const snapshot = Array.from({ length: 200 }, (_, index) => `ROW_${index}`).join('\r\n')
  const replay = (preserveScroll = false, cols = 80) => {
    handleMsg(scope, { type: 'init', cols, rows: 24, initialData: snapshot, preserveScroll })
    frames.shift()?.(0)
  }
  const drain = () => new Promise<void>((resolve) => afterWritesDrained(scope, resolve))
  return { scope, terminals, replay, drain }
}

afterEach(() => {
  for (const scope of scopes.splice(0)) {
    stopTerminalDocument(scope)
  }
  vi.unstubAllGlobals()
})

describe('mobile terminal replay reading position', () => {
  it('keeps the committed reading position when a newer snapshot overtakes an unfinished replay', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.terminals[0]!.scrollToLine(40)
    expect(harness.scope.committedTerm!.buffer.active.viewportY).toBe(40)

    harness.replay(true, 81)
    // A second host resize snapshot arrives while the first replacement is still hidden.
    expect(harness.scope.pendingSurface).not.toBeNull()
    harness.replay(true, 82)
    await harness.drain()

    expect(harness.scope.committedTerm!.buffer.active.viewportY).toBe(40)
    expect(harness.scope.committedTerm!.buffer.active.getLine(40)?.translateToString(true)).toBe(
      'ROW_40'
    )
    expect(document.querySelectorAll('#terminal-container > div')).toHaveLength(1)
  })

  it('anchors a superseding replay to the committed buffer instead of the pending buffer', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.terminals[0]!.scrollToLine(40)

    harness.replay(true, 81)
    harness.terminals[0]!.scrollToLine(60)
    harness.replay(true, 82)
    await harness.drain()

    expect(harness.scope.committedTerm!.buffer.active.viewportY).toBe(60)
  })

  it('keeps a reader pinned through one snapshot and subsequent live output', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.terminals[0]!.scrollToLine(40)

    harness.replay(true, 81)
    await harness.drain()
    handleMsg(harness.scope, { type: 'write', data: '\r\nLIVE_OUTPUT' })
    await harness.drain()

    expect(harness.scope.committedTerm!.buffer.active.viewportY).toBe(40)
  })

  it('continues following output when the reader was already at the bottom', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.replay(true, 81)
    harness.replay(true, 82)
    await harness.drain()
    handleMsg(harness.scope, { type: 'write', data: '\r\nLIVE_OUTPUT' })
    await harness.drain()

    const buffer = harness.scope.committedTerm!.buffer.active
    expect(buffer.viewportY).toBe(buffer.baseY)
    expect(buffer.getLine(buffer.length - 1)?.translateToString(true)).toBe('LIVE_OUTPUT')
  })
})
