// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document/document-scope'
import { documentModuleSource } from './document/document-module-source.test-support'
import { emitKeyboardAvoidanceMetrics } from './document/keyboard-avoidance-metrics'
import { commitFitScale } from './document/fit-scale'
import { parseTerminalKeyboardAvoidanceMetrics } from './terminal-webview-contract'

// The scope object plus the metrics block, exactly as the document carries them.
/**
 * The metrics module over a scope the case owns.
 *
 * Imported rather than evaluated: the module reads the terminal and the notify seam off the scope
 * it is handed, so a case builds one with its own terminal double and reads the notifications back
 * out of the seam it passed in.
 */
function runMetricsOver(term: unknown, fitScale = 1): Record<string, unknown>[] {
  const notifications: Record<string, unknown>[] = []
  const scope = createTerminalDocumentScope({
    postToHost: (message) => notifications.push(message)
  })
  scope.currentScale = fitScale
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each case's double implements the buffer members the scan reads, which is what the assertions check.
  scope.term = term as typeof scope.term
  emitKeyboardAvoidanceMetrics(scope)
  return notifications
}

type Cell = { isBgDefault: () => boolean; isInverse: () => number }
type MetricsNotification = {
  type: string
  cursorY: number
  contentBottomRow: number
  rows: number
  altScreen: boolean
}

function makeLine(text = '', styledColumns: number[] = []) {
  const styled = new Set(styledColumns)
  return {
    isWrapped: false,
    length: 10,
    translateToString: vi.fn(() => text),
    getCell: (column: number): Cell => ({
      isBgDefault: () => !styled.has(column),
      isInverse: () => 0
    })
  }
}

function runMetrics(lines: (ReturnType<typeof makeLine> | undefined)[], altScreen = false) {
  const buffer = {
    cursorY: 2,
    viewportY: 3,
    type: altScreen ? 'alternate' : 'normal',
    getLine: (index: number) => lines[index - 3],
    getNullCell: () => ({})
  }
  const notified = runMetricsOver({ buffer: { active: buffer }, cols: 10, rows: lines.length })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the module emits one keyboard-avoidance notify, whose shape this file declares.
  return notified[0] as MetricsNotification
}

function runTerminalMetrics(term: Terminal) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a real xterm terminal satisfies the document's own narrower shape, which is what the scope field holds.
  return runMetricsOver(term)[0] as MetricsNotification
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('terminal keyboard-avoidance WebView metrics', () => {
  it('finds text on wrapped rows using the visible viewport offset', () => {
    const lines = [makeLine('header'), makeLine(''), makeLine('wrapped footer')]
    lines[2]!.isWrapped = true
    expect(runMetrics(lines)).toMatchObject({ contentBottomRow: 2 })
  })

  it('supports cells without decoration APIs and keeps background-only ANSI chrome visible', () => {
    expect(runMetrics([makeLine('header'), makeLine(''), makeLine('')])).toMatchObject({
      contentBottomRow: 0
    })
    expect(runMetrics([makeLine('header'), makeLine(''), makeLine('', [4])])).toMatchObject({
      contentBottomRow: 2
    })
  })

  it('classifies real xterm text and styled whitespace by rendered visibility', async () => {
    const cases = [
      { name: 'default spaces', data: '     ', expected: 0 },
      { name: 'text', data: 'footer', expected: 7 },
      { name: 'background', data: '\x1b[41m     \x1b[0m', expected: 7 },
      { name: 'inverse', data: '\x1b[7m     \x1b[0m', expected: 7 },
      { name: 'underline', data: '\x1b[4m     \x1b[0m', expected: 7 },
      { name: 'strikethrough', data: '\x1b[9m     \x1b[0m', expected: 7 },
      { name: 'overline', data: '\x1b[53m     \x1b[0m', expected: 7 },
      // Hidden text still reserves TUI layout, so keyboard avoidance treats it as content.
      { name: 'invisible text', data: '\x1b[8mfooter\x1b[0m', expected: 7 }
    ]

    for (const { name, data, expected } of cases) {
      const term = new Terminal({ cols: 10, rows: 8 })
      try {
        await write(term, `\x1b[8;1H${data}`)
        expect(runTerminalMetrics(term), name).toMatchObject({ contentBottomRow: expected })
      } finally {
        term.dispose()
      }
    }
  })

  it('tracks the real xterm viewport and alternate screen', async () => {
    const term = new Terminal({ cols: 10, rows: 4, scrollback: 100 })
    try {
      await write(term, 'header\r\n\r\n\r\n\r\nfooter')
      expect(runTerminalMetrics(term)).toMatchObject({ contentBottomRow: 3, altScreen: false })
      term.scrollLines(-2)
      expect(runTerminalMetrics(term)).toMatchObject({ contentBottomRow: 0, altScreen: false })
      await write(term, '\x1b[?1049h\x1b[4m     \x1b[0m')
      expect(runTerminalMetrics(term)).toMatchObject({ contentBottomRow: 0, altScreen: true })
    } finally {
      term.dispose()
    }
  })

  it('follows real xterm resize and reset state', async () => {
    const term = new Terminal({ cols: 10, rows: 8 })
    try {
      await write(term, '\x1b[8;1Hfooter')
      expect(runTerminalMetrics(term)).toMatchObject({ contentBottomRow: 7 })
      term.resize(10, 4)
      expect(runTerminalMetrics(term)).toMatchObject({ contentBottomRow: 3 })
      term.reset()
      expect(runTerminalMetrics(term)).toMatchObject({ contentBottomRow: 0 })
    } finally {
      term.dispose()
    }
  })

  it('keeps real xterm metrics compatible with old payloads', async () => {
    const term = new Terminal({ cols: 10, rows: 8 })
    try {
      await write(term, '\x1b[8;1Hfooter\x1b[2;1H')
      const { cursorY, rows, altScreen } = runTerminalMetrics(term)
      expect(parseTerminalKeyboardAvoidanceMetrics({ cursorY, rows, altScreen })).toEqual({
        cursorY: 1,
        contentBottomRow: 1,
        rows: 8,
        altScreen: false
      })
    } finally {
      term.dispose()
    }
  })

  it('releases real xterm metric observers across terminal lifecycles', async () => {
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const term = new Terminal({ cols: 10, rows: 4 })
      let emissions = 0
      const observer = term.onWriteParsed(() => {
        runTerminalMetrics(term)
        emissions += 1
      })
      try {
        await write(term, `cycle ${cycle}`)
        expect(emissions).toBeGreaterThan(0)
        observer.dispose()
        const disposedAt = emissions
        await write(term, ' after dispose')
        expect(emissions).toBe(disposedAt)
      } finally {
        observer.dispose()
        term.dispose()
      }
    }
  })

  it('stops at the first bottom-up match and skips scans on alternate screen', () => {
    const footer = makeLine('footer')
    const header = makeLine('header')
    expect(runMetrics([header, makeLine(''), footer])).toMatchObject({ contentBottomRow: 2 })
    expect(footer.translateToString).toHaveBeenCalledTimes(1)
    expect(header.translateToString).not.toHaveBeenCalled()

    footer.translateToString.mockImplementation(() => {
      throw new Error('alternate screen must not scan')
    })
    expect(runMetrics([header, makeLine(''), footer], true)).toMatchObject({
      altScreen: true,
      contentBottomRow: 0
    })
  })

  it('refreshes metrics after every buffer geometry reset', () => {
    // Four places change the buffer's geometry, and each owes a fresh emit after it: a stale
    // content-bottom row is what lifts the keyboard over the wrong line. Read from each module's
    // own source, so a fifth site added in a new module is not silently uncovered.
    const blocks = [
      ['terminal-init', 'export function resize('],
      ['reflow', 'export function reflow('],
      ['host-message-router', "} else if (msg.type === 'clear') {"],
      ['text-scaling', 'export function applyTextScale(']
    ] as const

    for (const [module, opener] of blocks) {
      const source = documentModuleSource(module)
      const start = source.indexOf(opener)
      expect(start, `${module} no longer carries ${opener}`).toBeGreaterThanOrEqual(0)
      const block = source.slice(start, source.indexOf('\n}', start))
      const emitAt = block.indexOf('emitKeyboardAvoidanceMetrics(scope)')
      const geometryAt = block.includes('.resize(')
        ? block.indexOf('.resize(')
        : block.indexOf('.reset(')
      expect(emitAt, `${module} does not emit metrics`).toBeGreaterThanOrEqual(0)
      expect(emitAt, `${module} emits before it resizes`).toBeGreaterThan(geometryAt)
    }
  })

  it('reports the row pitch as drawn, fit scale included, and none before a cell is measured', () => {
    // Desktop display mode keeps the desktop's rows and the fit shrinks the grid by width.
    const buffer = { cursorY: 0, viewportY: 0, type: 'normal', getLine: () => undefined }
    const measuredTerm = {
      buffer: { active: buffer },
      cols: 10,
      rows: 47,
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } }
    }
    const phone = runMetricsOver(measuredTerm)[0]
    const desktop = runMetricsOver(measuredTerm, 0.5)[0]
    const unmeasured = runMetricsOver({ buffer: { active: buffer }, cols: 10, rows: 47 })[0]
    expect({
      phone: phone?.rowPitch,
      desktop: desktop?.rowPitch,
      unmeasured: unmeasured?.rowPitch
    }).toEqual({ phone: 15, desktop: 7.5, unmeasured: 0 })
  })

  it('reports again when a fit commits a new scale, carrying the new pitch', () => {
    const notifications: Record<string, unknown>[] = []
    const scope = createTerminalDocumentScope({
      postToHost: (message) => notifications.push(message),
      // Half the width 80 columns of 8 px need, so the fit commits a scale of 0.5.
      viewportRect: () => ({ left: 0, top: 0, width: 320, height: 700 })
    })
    const buffer = { cursorY: 0, viewportY: 0, type: 'normal', getLine: () => undefined }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements every member the fit and the metrics read, which the assertion checks.
    scope.term = {
      buffer: { active: buffer },
      cols: 80,
      rows: 40,
      element: { scrollWidth: 640 },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } }
    } as unknown as typeof scope.term
    scope.surface = document.createElement('div')
    commitFitScale(scope, 'test', 0, 'test')
    const metrics = notifications.filter((message) => message.type === 'keyboard-avoidance-metrics')
    expect(metrics.at(-1)?.rowPitch).toBe(7.5)
  })
})
