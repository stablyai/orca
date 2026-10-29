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
  const writeCompletions: (() => void)[] = []
  let deferWrites = false
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
      // Real xterm parser and viewport, without a canvas renderer.
      return {
        ...terminalDocumentDouble().terminal,
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
        write: (data, callback) =>
          terminal.write(data, () => {
            if (callback && deferWrites) {
              writeCompletions.push(callback)
            } else {
              callback?.()
            }
          }),
        clear: () => terminal.clear(),
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
  return {
    scope,
    terminals,
    replay: (preserveScroll: boolean, cols: number, initialData = snapshot) => {
      handleMsg(scope, {
        type: 'init',
        cols,
        rows: 24,
        initialData,
        preserveScroll
      })
      frames.shift()?.(0)
    },
    drain: () => new Promise<void>((resolve) => afterWritesDrained(scope, resolve)),
    parse: () => new Promise<void>((resolve) => terminals.at(-1)!.write('', resolve)),
    holdReplays: (hold: boolean) => {
      deferWrites = hold
    },
    releaseHeldReplays: () => {
      for (const complete of writeCompletions.splice(0).toReversed()) {
        complete()
      }
    }
  }
}

type ReplayHarness = ReturnType<typeof createReplayHarness>

async function readAt40ThenOvertakeHiddenReplay({
  hiddenReplayData,
  duringHiddenReplay
}: {
  hiddenReplayData?: string
  duringHiddenReplay?: (harness: ReplayHarness) => void
} = {}) {
  const harness = createReplayHarness()
  harness.replay(false, 80)
  await harness.drain()
  harness.terminals[0]!.scrollToLine(40)
  harness.holdReplays(true)
  harness.replay(true, 81, hiddenReplayData)
  await harness.parse()
  expect(harness.scope.pendingSurface).not.toBeNull()
  duringHiddenReplay?.(harness)
  harness.holdReplays(false)
  harness.replay(true, 82)
  await harness.drain()
  // The overtaken replay's late completion must not commit it or move the reader.
  harness.releaseHeldReplays()
  expect(harness.scope.pendingTerm).toBeNull()
  expect(document.querySelectorAll('#terminal-container > div')).toHaveLength(1)
  return harness.scope.committedTerm!.buffer.active
}

afterEach(() => {
  for (const scope of scopes.splice(0)) {
    stopTerminalDocument(scope)
  }
  vi.unstubAllGlobals()
})

describe('mobile terminal replay reading position', () => {
  it.each([
    { name: '' },
    {
      name: ' that printed live output',
      duringHiddenReplay: (harness: ReplayHarness) =>
        handleMsg(harness.scope, { type: 'write', data: '\r\nLIVE' })
    }
  ])(
    'keeps the reading position when a resize snapshot overtakes a hidden replay$name',
    async ({ name: _name, ...overtake }) => {
      const buffer = await readAt40ThenOvertakeHiddenReplay(overtake)

      expect(buffer.viewportY).toBe(40)
      expect(buffer.getLine(40)?.translateToString(true)).toBe('ROW_40')
    }
  )

  it.each([
    {
      name: 'the terminal was cleared',
      duringHiddenReplay: (harness: ReplayHarness) => handleMsg(harness.scope, { type: 'clear' })
    },
    {
      name: 'the hidden replay was an alternate screen',
      hiddenReplayData: '\x1b[?1049h\x1b[HTUI'
    }
  ])('follows the bottom when $name', async ({ name: _name, ...overtake }) => {
    const buffer = await readAt40ThenOvertakeHiddenReplay(overtake)

    expect(buffer.type).toBe('normal')
    expect(buffer.viewportY).toBe(buffer.baseY)
  })
})
