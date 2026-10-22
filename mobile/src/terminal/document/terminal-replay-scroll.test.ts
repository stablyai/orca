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

function createReplayHarness(measuredCell?: { width: number; height: number }) {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
  const terminals: Terminal[] = []
  const writeCompletions: Array<() => void> = []
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
      // Exercise xterm's real parser and viewport without requiring a canvas renderer.
      const documentTerminal = terminalDocumentDouble().terminal
      return {
        ...documentTerminal,
        _core: measuredCell
          ? { _renderService: { dimensions: { css: { cell: measuredCell } } } }
          : undefined,
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
            if (callback) {
              if (deferWrites) {
                writeCompletions.push(callback)
              } else {
                callback()
              }
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
  const replay = (preserveScroll = false, cols = 80, initialData = snapshot) => {
    handleMsg(scope, { type: 'init', cols, rows: 24, initialData, preserveScroll })
    frames.shift()?.(0)
  }
  const drain = () => new Promise<void>((resolve) => afterWritesDrained(scope, resolve))
  return {
    scope,
    terminals,
    replay,
    drain,
    snapshot,
    flushFrames: () => {
      for (const frame of frames.splice(0)) {
        frame(0)
      }
    },
    parse: () => new Promise<void>((resolve) => terminals.at(-1)!.write('', resolve)),
    deferWrites: (defer: boolean) => {
      deferWrites = defer
    },
    releaseWrites: () => {
      for (const complete of writeCompletions.splice(0).toReversed()) {
        complete()
      }
    }
  }
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

  it('ignores a cancelled replay completion after the newest replay and live output commit', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.terminals[0]!.scrollToLine(40)
    harness.deferWrites(true)
    harness.replay(true, 81)
    await harness.parse()
    const cancelled = vi.spyOn(harness.terminals[1]!, 'dispose')
    harness.terminals[0]!.scrollToLine(60)

    harness.deferWrites(false)
    harness.replay(true, 82)
    handleMsg(harness.scope, { type: 'write', data: '\r\nNEWEST_LIVE_OUTPUT' })
    await harness.drain()
    harness.releaseWrites()

    const buffer = harness.scope.committedTerm!.buffer.active
    expect(buffer.baseY - buffer.viewportY).toBe(116)
    expect(buffer.getLine(buffer.length - 1)?.translateToString(true)).toBe('NEWEST_LIVE_OUTPUT')
    expect(harness.scope.term).toBe(harness.scope.committedTerm)
    expect(harness.scope.pendingTerm).toBeNull()
    expect(cancelled).toHaveBeenCalledOnce()
    expect(document.querySelectorAll('#terminal-container > div')).toHaveLength(1)
  })

  it.each([
    ['alternate screen', '\x1b[?1049h\x1b[HTUI_CONTENT', 'alternate', 'TUI_CONTENT'],
    ['reset snapshot', '\x1bcRESET_CONTENT', 'normal', 'RESET_CONTENT']
  ])('does not apply a normal scrollback offset to a %s', async (_, snapshot, type, content) => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.terminals[0]!.scrollToLine(40)
    harness.replay(true, 81)
    harness.replay(true, 82, snapshot)
    await harness.drain()

    const buffer = harness.scope.committedTerm!.buffer.active
    expect(buffer.type).toBe(type)
    expect(buffer.viewportY).toBe(0)
    expect(buffer.baseY).toBe(0)
    expect(buffer.getLine(0)?.translateToString(true)).toBe(content)
  })

  it.each([false, true])(
    'follows bottom when an unparsed alternate snapshot is superseded (wheel=%s)',
    async (wheel) => {
      const harness = createReplayHarness()
      harness.replay()
      await harness.drain()
      harness.terminals[0]!.scrollToLine(40)
      harness.deferWrites(true)
      harness.replay(true, 81)
      await harness.parse()
      if (wheel) {
        harness.scope.committedSurface!.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -10,
            deltaMode: 1,
            bubbles: true,
            cancelable: true
          })
        )
        harness.flushFrames()
      }

      harness.replay(true, 60, '\x1b[?1049h\x1b[HTUI_CONTENT')
      expect(harness.scope.pendingTerm!.buffer.active.type).toBe('normal')
      harness.deferWrites(false)
      harness.replay(true, 75)
      await harness.drain()
      harness.releaseWrites()

      const buffer = harness.scope.committedTerm!.buffer.active
      expect(buffer.type).toBe('normal')
      expect(buffer.viewportY).toBe(buffer.baseY)
      expect(buffer.getLine(buffer.length - 1)?.translateToString(true)).toBe('ROW_199')
    }
  )

  it('follows bottom after a parsed pending alternate screen is replaced by normal output', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.terminals[0]!.scrollToLine(40)
    harness.deferWrites(true)
    harness.replay(true, 81, '\x1b[?1049h\x1b[HTUI_CONTENT')
    await harness.parse()
    expect(harness.scope.pendingTerm!.buffer.active.type).toBe('alternate')
    harness.replay(true, 82)
    await harness.parse()
    harness.deferWrites(false)
    harness.replay(true, 83)
    await harness.drain()
    harness.releaseWrites()
    const buffer = harness.scope.committedTerm!.buffer.active
    expect(buffer.type).toBe('normal')
    expect(buffer.viewportY).toBe(buffer.baseY)
  })

  it('does not revive the cleared reading position on a later replay', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.terminals[0]!.scrollToLine(40)
    handleMsg(harness.scope, { type: 'clear' })
    harness.replay(true, 81)
    harness.replay(true, 82)
    await harness.drain()

    const buffer = harness.scope.committedTerm!.buffer.active
    expect(buffer.viewportY).toBe(buffer.baseY)
  })

  it('disposes both replay surfaces and ignores a write completion after unmount', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    const committedDispose = vi.spyOn(harness.terminals[0]!, 'dispose')
    harness.deferWrites(true)
    harness.replay(true, 81)
    await harness.parse()
    const pendingDispose = vi.spyOn(harness.terminals[1]!, 'dispose')

    stopTerminalDocument(harness.scope)
    harness.releaseWrites()

    expect(committedDispose).toHaveBeenCalledOnce()
    expect(pendingDispose).toHaveBeenCalledOnce()
    expect(harness.scope.term).toBeNull()
    expect(harness.scope.committedTerm).toBeNull()
    expect(harness.scope.scheduledFrames).toEqual([])
  })

  it.each([false, true])(
    'does not resurrect an anchor cleared while a replay was pending (wheel=%s)',
    async (wheel) => {
      const harness = createReplayHarness()
      harness.replay()
      await harness.drain()
      harness.terminals[0]!.scrollToLine(40)
      harness.deferWrites(true)
      harness.replay(true, 81)
      await harness.parse()
      if (wheel) {
        harness.scope.committedSurface!.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -10,
            deltaMode: 1,
            bubbles: true,
            cancelable: true
          })
        )
        harness.flushFrames()
      }
      handleMsg(harness.scope, { type: 'clear' })
      harness.deferWrites(false)
      harness.replay(true, 82)
      await harness.drain()
      harness.releaseWrites()

      const buffer = harness.scope.committedTerm!.buffer.active
      expect(buffer.viewportY).toBe(buffer.baseY)
    }
  )

  it('keeps only the last of eight replacements and honors its non-preserving reset', async () => {
    const harness = createReplayHarness()
    harness.replay()
    await harness.drain()
    harness.terminals[0]!.scrollToLine(40)
    harness.deferWrites(true)
    for (let index = 1; index <= 8; index++) {
      harness.replay(true, 80 + index)
      await harness.parse()
      harness.terminals[0]!.scrollToLine(40 + index)
    }

    harness.deferWrites(false)
    harness.replay(false, 89)
    await harness.drain()
    harness.releaseWrites()
    handleMsg(harness.scope, { type: 'write', data: '\r\nAFTER_RESET' })
    await harness.drain()

    const buffer = harness.scope.committedTerm!.buffer.active
    expect(buffer.viewportY).toBe(buffer.baseY)
    expect(buffer.getLine(buffer.length - 1)?.translateToString(true)).toBe('AFTER_RESET')
    expect(harness.scope.pendingTerm).toBeNull()
    expect(document.querySelectorAll('#terminal-container > div')).toHaveLength(1)
  })

  it('follows a normal snapshot when the committed terminal was on the alternate screen', async () => {
    const harness = createReplayHarness()
    harness.replay(false, 80, harness.snapshot + '\x1b[?1049h\x1b[HTUI_CONTENT')
    await harness.drain()
    expect(harness.scope.committedTerm!.buffer.active.type).toBe('alternate')

    harness.replay(true, 81)
    harness.replay(true, 82)
    await harness.drain()

    const buffer = harness.scope.committedTerm!.buffer.active
    expect(buffer.type).toBe('normal')
    expect(buffer.viewportY).toBe(buffer.baseY)
    expect(buffer.getLine(buffer.length - 1)?.translateToString(true)).toBe('ROW_199')
  })
})

describe('pending replay scroll policy', () => {
  it.each([
    { preservePending: true, wheelDeltas: [], expectedViewport: 40 },
    { preservePending: false, wheelDeltas: [], expectedViewport: 176 },
    { preservePending: true, wheelDeltas: [-10], expectedViewport: 166 },
    { preservePending: false, wheelDeltas: [-10], expectedViewport: 166 },
    { preservePending: true, wheelDeltas: [-10, 10], expectedViewport: 176 },
    { preservePending: false, wheelDeltas: [-10, 10], expectedViewport: 176 },
    { preservePending: true, wheelDeltas: [10], expectedViewport: 40 }
  ])(
    'honors pending preserve=$preservePending and wheels=$wheelDeltas through repeated replay',
    async ({ preservePending, wheelDeltas, expectedViewport }) => {
      const harness = createReplayHarness()
      harness.replay()
      await harness.drain()
      harness.terminals[0]!.scrollToLine(40)
      harness.deferWrites(true)
      harness.replay(preservePending, 81)
      await harness.parse()
      for (const deltaY of wheelDeltas) {
        harness.scope.committedSurface!.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY,
            deltaMode: 1,
            bubbles: true,
            cancelable: true
          })
        )
        harness.flushFrames()
      }
      harness.replay(true, 82)
      await harness.parse()
      harness.deferWrites(false)
      harness.replay(true, 83)
      await harness.drain()
      harness.releaseWrites()
      expect(harness.scope.committedTerm!.buffer.active.viewportY).toBe(expectedViewport)
      expect(harness.scope.pendingTerm).toBeNull()
      expect(document.querySelectorAll('#terminal-container > div')).toHaveLength(1)
    }
  )
})

describe('live output during pending replay', () => {
  it.each([
    { reset: false, wheelDeltas: [], expectedViewport: 177 },
    { reset: false, wheelDeltas: [-10], expectedViewport: 166 },
    { reset: false, wheelDeltas: [-10, 10], expectedViewport: 177 },
    { reset: true, wheelDeltas: [], expectedViewport: 176 },
    { reset: true, wheelDeltas: [-10], expectedViewport: 176 },
    { reset: true, wheelDeltas: [-10, 10], expectedViewport: 176 }
  ])(
    'uses the pending viewport after live reset=$reset and wheels=$wheelDeltas',
    async ({ reset, wheelDeltas, expectedViewport }) => {
      const harness = createReplayHarness()
      harness.replay()
      await harness.drain()
      harness.terminals[0]!.scrollToLine(40)
      harness.deferWrites(true)
      harness.replay(true, 81)
      await harness.parse()
      for (const deltaY of wheelDeltas) {
        harness.scope.committedSurface!.dispatchEvent(
          new WheelEvent('wheel', { deltaY, deltaMode: 1, bubbles: true, cancelable: true })
        )
        harness.flushFrames()
      }
      const resetSnapshot = harness.snapshot.replaceAll('ROW_', 'RESET_')
      const liveOutput = reset ? '\x1bc' + resetSnapshot : '\r\nLIVE'
      handleMsg(harness.scope, { type: 'write', data: liveOutput })
      harness.releaseWrites()
      await harness.parse()
      harness.deferWrites(false)
      harness.replay(true, 82, reset ? resetSnapshot : harness.snapshot + liveOutput)
      await harness.drain()
      harness.releaseWrites()

      const buffer = harness.scope.committedTerm!.buffer.active
      expect(buffer.viewportY).toBe(expectedViewport)
      expect(buffer.getLine(buffer.length - 1)?.translateToString(true)).toBe(
        reset ? 'RESET_199' : 'LIVE'
      )
      expect(harness.scope.pendingTerm).toBeNull()
    }
  )
})

describe('pending replay geometry', () => {
  function changeGeometry(
    harness: ReturnType<typeof createReplayHarness>,
    type: string,
    cols: number,
    rows: number
  ) {
    if (type === 'set-font-scale') {
      harness.scope.hostFrame = { width: cols * 8, height: rows * 15 }
      handleMsg(harness.scope, { type, fontScale: 1.25 })
      harness.flushFrames()
    } else {
      handleMsg(harness.scope, { type, cols, rows })
    }
  }

  it.each(['resize', 'reflow', 'set-font-scale'])(
    'uses the actual pending viewport after %s consumes its scrollback',
    async (type) => {
      const harness = createReplayHarness({ width: 8, height: 15 })
      const snapshot = Array.from({ length: 30 }, (_, index) => `ROW_${index}`).join('\r\n')
      harness.replay(false, 80, snapshot)
      await harness.drain()
      harness.terminals[0]!.scrollToLine(2)
      harness.deferWrites(true)
      harness.replay(true, 81, snapshot)
      await harness.parse()
      harness.scope.committedSurface!.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -2, deltaMode: 1, bubbles: true, cancelable: true })
      )
      harness.flushFrames()
      expect(harness.scope.term!.buffer.active.viewportY).toBe(4)

      changeGeometry(harness, type, 81, 40)
      expect(harness.scope.term!.buffer.active.baseY).toBe(0)
      harness.deferWrites(false)
      harness.replay(true, 82, snapshot)
      await harness.drain()
      harness.releaseWrites()
      const buffer = harness.scope.committedTerm!.buffer.active
      expect(buffer.viewportY).toBe(buffer.baseY)
      expect(buffer.viewportY).toBe(6)
      expect(buffer.getLine(buffer.viewportY)?.translateToString(true)).toBe('ROW_6')
    }
  )

  it.each(['resize', 'reflow', 'set-font-scale'])(
    'retains an unmaterialized pending gesture through a no-op %s',
    async (type) => {
      const harness = createReplayHarness({ width: 8, height: 15 })
      harness.replay()
      await harness.drain()
      harness.terminals[0]!.scrollToLine(40)
      harness.deferWrites(true)
      harness.replay(true, 81)
      await harness.parse()
      harness.scope.committedSurface!.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -10, deltaMode: 1, bubbles: true, cancelable: true })
      )
      harness.flushFrames()
      harness.replay(true, 82)
      await harness.parse()

      changeGeometry(harness, type, 82, 24)
      harness.deferWrites(false)
      harness.replay(true, 83)
      await harness.drain()
      harness.releaseWrites()
      expect(harness.scope.committedTerm!.buffer.active.viewportY).toBe(166)
    }
  )

  it.each(['resize', 'reflow', 'set-font-scale'])(
    'retains committed inheritance through %s without a pending override',
    async (type) => {
      const harness = createReplayHarness({ width: 8, height: 15 })
      harness.replay()
      await harness.drain()
      harness.terminals[0]!.scrollToLine(40)
      harness.deferWrites(true)
      harness.replay(true, 81)
      await harness.parse()

      changeGeometry(harness, type, 82, 40)
      harness.deferWrites(false)
      harness.replay(true, 83)
      await harness.drain()
      harness.releaseWrites()
      expect(harness.scope.committedTerm!.buffer.active.viewportY).toBe(40)
    }
  )

  it.each(['resize', 'reflow', 'set-font-scale'])(
    'follows normal output after pending alternate-screen %s',
    async (type) => {
      const harness = createReplayHarness({ width: 8, height: 15 })
      harness.replay()
      await harness.drain()
      harness.terminals[0]!.scrollToLine(40)
      harness.deferWrites(true)
      harness.replay(true, 81, '\x1b[?1049hALT')
      await harness.parse()

      changeGeometry(harness, type, 82, 40)
      harness.deferWrites(false)
      harness.replay(true, 83)
      await harness.drain()
      harness.releaseWrites()
      const buffer = harness.scope.committedTerm!.buffer.active
      expect(buffer.type).toBe('normal')
      expect(buffer.viewportY).toBe(buffer.baseY)
    }
  )
})
