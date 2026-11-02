// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocument } from './create-terminal-document'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import type { TerminalDocumentLine } from './document-terminal-shape'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html'

const CELL_W = 8
const CELL_H = 15
const COLS = 40
const ROW = 5
const LINE = 'alpha beta gamma delta'

const cellPoint = (col: number, row: number) => ({
  x: col * CELL_W + CELL_W / 2,
  y: row * CELL_H + CELL_H / 2
})

function textLine(text: string): TerminalDocumentLine {
  return {
    length: text.length,
    isWrapped: false,
    translateToString: (_trimRight, start, end) => text.slice(start ?? 0, end ?? text.length)
  }
}

let stopDocument: (() => void) | null = null

afterEach(() => {
  stopDocument?.()
  stopDocument = null
  vi.useRealTimers()
})

async function startTuiDocument() {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  const host = document.createElement('div')
  host.innerHTML = TERMINAL_DOCUMENT_MARKUP
  document.body.appendChild(host)
  const engine = terminalDocumentDouble()
  const selections: [number, number, number][] = []
  let clears = 0
  const grid = Object.assign(engine.terminal, {
    cols: COLS,
    rows: 24,
    buffer: {
      active: {
        length: 24,
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        type: 'alternate',
        getLine: (row: number) => (row === ROW ? textLine(LINE) : undefined)
      }
    },
    _core: { _renderService: { dimensions: { css: { cell: { width: CELL_W, height: CELL_H } } } } }
  })
  grid.select = (col: number, row: number, length: number) => {
    selections.push([col, row, length])
  }
  grid.clearSelection = () => {
    clears += 1
  }
  const posted: Record<string, unknown>[] = []
  const started = createTerminalDocument({
    root: host,
    postToHost: (message) => {
      posted.push(message)
    },
    hasEngine: () => true,
    installHostTransport: () => () => {},
    installErrorReporter: () => () => {},
    paintDocumentBackground: () => {},
    viewportRect: () => ({ left: 0, top: 0, width: 412, height: 600 }),
    createTerminal: () => grid,
    createUnicode11Addon: () => null,
    createWebglAddon: () => null
  })
  stopDocument = () => started.stop()
  started.send({
    type: 'init',
    cols: COLS,
    rows: 24,
    initialData: '',
    preserveScroll: false,
    frame: { width: 412, height: 600 }
  })
  await vi.advanceTimersByTimeAsync(160)
  posted.length = 0
  selections.length = 0
  const surface = host.querySelector<HTMLElement>('#terminal-surface')!

  function touch(type: string, point?: { x: number; y: number }) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: point ? [{ identifier: 0, clientX: point.x, clientY: point.y, target: surface }] : []
    })
    surface.dispatchEvent(event)
  }
  const ofType = (type: string) => posted.filter((message) => message.type === type)
  return {
    touch,
    ofType,
    selections,
    clears: () => clears,
    setActive: (active: boolean) => started.send({ type: 'set-interaction-active', active })
  }
}

describe('long press then drag on the terminal surface', () => {
  it('extends the selection with the same finger instead of scrolling the program', async () => {
    const doc = await startTuiDocument()

    doc.touch('touchstart', cellPoint(7, ROW))
    vi.advanceTimersByTime(500)
    expect(doc.ofType('set-select-mode').at(-1)).toMatchObject({ enabled: true })
    expect(doc.selections.at(-1)).toEqual([6, ROW, 4])

    doc.touch('touchmove', cellPoint(18, ROW))
    expect(doc.selections.at(-1)).toEqual([6, ROW, 13])
    doc.touch('touchmove', cellPoint(2, ROW + 2))
    expect(doc.selections.at(-1)).toEqual([6, ROW, COLS - 6 + COLS + 3])
    expect(doc.ofType('terminal-input')).toEqual([])
  })

  it('keeps the dragged selection when the finger lifts', async () => {
    const doc = await startTuiDocument()

    doc.touch('touchstart', cellPoint(7, ROW))
    vi.advanceTimersByTime(500)
    doc.touch('touchmove', cellPoint(18, ROW))
    const clearsBeforeLift = doc.clears()
    doc.touch('touchend')

    expect(doc.ofType('set-select-mode').map((message) => message.enabled)).toEqual([true])
    expect(doc.clears()).toBe(clearsBeforeLift)
    expect(doc.selections.at(-1)).toEqual([6, ROW, 13])
    expect(doc.ofType('terminal-tap')).toEqual([])
    expect(doc.ofType('terminal-input')).toEqual([])
  })

  it('still scrolls and never selects when the finger moves before the press matures', async () => {
    const doc = await startTuiDocument()

    doc.touch('touchstart', cellPoint(7, ROW))
    doc.touch('touchmove', cellPoint(7, ROW + 3))
    vi.advanceTimersByTime(600)
    doc.touch('touchend')

    expect(doc.ofType('terminal-input').length).toBeGreaterThan(0)
    expect(doc.ofType('set-select-mode')).toEqual([])
    expect(doc.selections).toEqual([])
  })
})

it('requires a new touch after a hide/show interruption before scrolling resumes', async () => {
  const doc = await startTuiDocument()
  doc.touch('touchstart', cellPoint(7, ROW))
  doc.setActive(false)
  doc.setActive(true)
  doc.touch('touchmove', cellPoint(7, ROW + 3))
  doc.touch('touchend')
  vi.advanceTimersByTime(600)
  expect(doc.ofType('terminal-input')).toEqual([])
  expect(doc.ofType('set-select-mode')).toEqual([])
  doc.touch('touchstart', cellPoint(7, ROW))
  doc.touch('touchmove', cellPoint(7, ROW + 3))
  expect(doc.ofType('terminal-input').length).toBeGreaterThan(0)
})
