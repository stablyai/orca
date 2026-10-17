// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html/document-markup'
import { DEFAULT_TERMINAL_THEME } from '../terminal-webview-html/theme'
import { lastRowBackground, paintBottomRowBackdrop } from './bottom-row-backdrop'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import { elementInRoot, type TerminalDocumentHost } from './document-host-seams'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import type { TerminalDocumentCell, TerminalDocumentLine } from './document-terminal-shape'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { handleMsg } from './host-message-router'

// The phone in the report: a 55x41 grid of 17px rows, with 0.67px of frame left under row 41.
const CELL = { width: 8, height: 17 }
const COLS = 55
const ROWS = 41
const GRID_BOTTOM = ROWS * CELL.height
const FRAME = { left: 0, top: 0, width: COLS * CELL.width, height: GRID_BOTTOM + 0.67 }
const NAVY = 'rgb(14, 20, 37)'
const NAVY_RGB = 0x0e1425

type Background = number | 'default' | 'palette' | 'inverse'

function cellWith(background: Background): TerminalDocumentCell {
  return {
    isBgDefault: () => background === 'default' || background === 'inverse',
    isBgRGB: () => typeof background === 'number',
    getBgColor: () => (typeof background === 'number' ? background : 0),
    isInverse: () => (background === 'inverse' ? 1 : 0)
  }
}

function rowOf(backgrounds: Background[]): TerminalDocumentLine {
  return {
    length: backgrounds.length,
    translateToString: () => '',
    getCell: (x) => cellWith(backgrounds[x])
  }
}

const uniformRow = (background: Background) => rowOf(Array.from({ length: COLS }, () => background))

const fillFor = (color: string, bottom = GRID_BOTTOM) =>
  `linear-gradient(to bottom, transparent ${bottom}px, ${color} ${bottom}px)`

/** The terminal double with a laid-out grid whose last visible row the case chooses. */
function gridTerminal(rows: { last: TerminalDocumentLine }) {
  const double = terminalDocumentDouble()
  const terminal = Object.assign(double.terminal, {
    cols: COLS,
    rows: ROWS,
    buffer: {
      active: {
        length: ROWS,
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        type: 'normal',
        getNullCell: () => cellWith('default'),
        getLine: (y: number) => (y === ROWS - 1 ? rows.last : uniformRow('default'))
      }
    },
    _core: { _renderService: { dimensions: { css: { cell: CELL } } } }
  })
  return terminal
}

function gridScope(last: TerminalDocumentLine, host: TerminalDocumentHost = {}) {
  document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
  const scope = createTerminalDocumentScope({ viewportRect: () => FRAME, ...host })
  const terminal = gridTerminal({ last })
  terminal.open(document.createElement('div'))
  scope.term = terminal
  return scope
}

const backdrop = () => elementInRoot(null, 'terminal-container')!.style.backgroundImage

describe('the strip under the last terminal row', () => {
  it("takes a truecolor last row's colour", () => {
    // A TUI that paints its own background left a theme-coloured band here.
    const scope = gridScope(uniformRow(NAVY_RGB))
    paintBottomRowBackdrop(scope)
    expect(backdrop()).toBe(fillFor(NAVY))
  })

  it('takes the live default background, as OSC 11 left it, under a default last row', () => {
    const scope = gridScope(uniformRow('default'))
    // xterm writes the live default background onto its element, OSC 11 included.
    scope.term!.element!.style.backgroundColor = 'rgb(26, 26, 26)'
    paintBottomRowBackdrop(scope)
    expect(backdrop()).toBe(fillFor('rgb(26, 26, 26)'))
  })

  it('keeps the theme under a mixed, palette or inverse last row', () => {
    for (const last of [
      rowOf([NAVY_RGB, ...Array.from({ length: COLS - 1 }, () => 'default' as const)]),
      uniformRow('palette'),
      uniformRow('inverse')
    ]) {
      const scope = gridScope(last)
      paintBottomRowBackdrop(scope)
      expect(backdrop()).toBe('')
    }
  })

  it('keeps the theme in a gap of a whole row or more', () => {
    const exactRow = gridScope(uniformRow(NAVY_RGB), {
      viewportRect: () => ({ ...FRAME, height: GRID_BOTTOM + CELL.height })
    })
    paintBottomRowBackdrop(exactRow)
    expect(backdrop()).toBe('')

    // A desktop-sized grid fitted to the phone's width leaves empty space, not a sliver of a row.
    const desktopSized = gridScope(uniformRow(NAVY_RGB))
    desktopSized.currentScale = 0.5
    paintBottomRowBackdrop(desktopSized)
    expect(backdrop()).toBe('')
  })

  it('clears the strip once the grid covers the frame', () => {
    const scope = gridScope(uniformRow(NAVY_RGB))
    paintBottomRowBackdrop(scope)
    expect(backdrop()).toBe(fillFor(NAVY))
    scope.userScale = 1.5
    paintBottomRowBackdrop(scope)
    expect(backdrop()).toBe('')
  })

  it('follows the strip where a scaled grid ends', () => {
    // Just under a row of gap at this scale, so the strip is still the last row's.
    const scale = 0.99
    const scaledBottom = ROWS * (CELL.height * scale)
    const scope = gridScope(uniformRow(NAVY_RGB), {
      viewportRect: () => ({ ...FRAME, height: scaledBottom + CELL.height * scale - 1 })
    })
    scope.currentScale = scale
    paintBottomRowBackdrop(scope)
    expect(backdrop()).toBe(fillFor(NAVY, scaledBottom))
  })
})

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

/** A real xterm buffer read through the document's own scan. */
function lastRowOf(term: unknown) {
  const scope = createTerminalDocumentScope()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a real xterm terminal satisfies the document's narrower shape, which is what the scope field holds.
  scope.term = term as TerminalDocumentScope['term']
  return lastRowBackground(scope)
}

describe("xterm's own cells", () => {
  it('names a truecolor row and declines palette and inverse rows', async () => {
    const cases = [
      { name: 'truecolor', data: '\x1b[48;2;14;20;37m\x1b[K', expected: NAVY },
      { name: 'palette', data: '\x1b[42m\x1b[K', expected: null },
      // Erasing carries the background but not inverse, so the row is filled with inverse text.
      { name: 'inverse', data: '\x1b[7m' + ' '.repeat(10), expected: null },
      { name: 'mixed', data: '\x1b[48;2;14;20;37m  \x1b[0m', expected: null }
    ]
    for (const { name, data, expected } of cases) {
      const term = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
      try {
        await write(term, `\x1b[4;1H${data}`)
        expect(lastRowOf(term), name).toBe(expected)
      } finally {
        term.dispose()
      }
    }
  })

  it('reads the visible bottom row while scrolled back', async () => {
    const term = new Terminal({ cols: 10, rows: 2, scrollback: 10, allowProposedApi: true })
    try {
      // Line 1 is navy; at the bottom the viewport shows lines 2-3, scrolled to the top lines 0-1.
      await write(term, '\r\n\x1b[48;2;14;20;37m\x1b[K\x1b[0m\r\n\r\n')
      expect(lastRowOf(term)).toBe(DEFAULT_TERMINAL_THEME.background)
      term.scrollToLine(0)
      expect(lastRowOf(term)).toBe(NAVY)
    } finally {
      term.dispose()
    }
  })
})

const started: TerminalDocumentScope[] = []

afterEach(() => {
  while (started.length > 0) {
    stopTerminalDocument(started.pop()!)
  }
})

/** A started document over the grid, with the xterm listeners it installed handed back. */
function startedDocument(last: TerminalDocumentLine) {
  document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
  const rows = { last }
  const terminal = gridTerminal(rows)
  const parsed: (() => void)[] = []
  const scroll: (() => void)[] = []
  const listeners = { parsed, scroll }
  terminal.onWriteParsed = (listener) => {
    listeners.parsed.push(listener)
    return { dispose() {} }
  }
  terminal.onScroll = (listener) => {
    listeners.scroll.push(listener)
    return { dispose() {} }
  }
  const scope = createTerminalDocumentScope({
    installHostTransport: () => () => {},
    hasEngine: () => true,
    createTerminal: () => terminal,
    viewportRect: () => FRAME
  })
  startTerminalDocument(scope)
  started.push(scope)
  handleMsg(scope, { type: 'init', cols: COLS, rows: ROWS, initialData: '', preserveScroll: false })
  return { scope, rows, listeners }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

describe('the running document', () => {
  it('repaints the strip after a parsed write and after a theme change', () => {
    const { scope, rows, listeners } = startedDocument(uniformRow('default'))
    expect(listeners.parsed).toHaveLength(1)

    rows.last = uniformRow(NAVY_RGB)
    listeners.parsed[0]()
    expect(backdrop()).toBe(fillFor(NAVY))

    // A default last row follows a theme the host publishes.
    rows.last = uniformRow('default')
    handleMsg(scope, { type: 'set-theme', terminalTheme: { theme: { background: '#101010' } } })
    expect(backdrop()).toBe(fillFor('#101010'))
  })

  it('paints the strip when the fit commits and again when the viewport scrolls', async () => {
    const { rows, listeners } = startedDocument(uniformRow(NAVY_RGB))
    for (let frame = 0; frame < 30 && backdrop() === ''; frame++) {
      await nextFrame()
    }
    expect(backdrop()).toBe(fillFor(NAVY))

    rows.last = uniformRow('palette')
    listeners.scroll[0]()
    expect(backdrop()).toBe('')
  })
})
