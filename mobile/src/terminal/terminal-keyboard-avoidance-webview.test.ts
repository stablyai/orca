// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { createTerminalDocumentScope } from './document/document-scope'
import { emitKeyboardAvoidanceMetrics } from './document/keyboard-avoidance-metrics'
import { commitFitScale } from './document/fit-scale'

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
type MetricsNotification = {
  type: string
  cursorY: number
  contentBottomRow: number
  rows: number
  altScreen: boolean
}

function checkedMetrics(value: Record<string, unknown> | undefined): MetricsNotification {
  if (
    !value ||
    typeof value.type !== 'string' ||
    typeof value.cursorY !== 'number' ||
    typeof value.contentBottomRow !== 'number' ||
    typeof value.rows !== 'number' ||
    typeof value.altScreen !== 'boolean'
  ) {
    throw new Error('Missing terminal metrics')
  }
  return {
    type: value.type,
    cursorY: value.cursorY,
    contentBottomRow: value.contentBottomRow,
    rows: value.rows,
    altScreen: value.altScreen
  }
}

function runTerminalMetrics(term: Terminal) {
  return checkedMetrics(runMetricsOver(term)[0])
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('terminal keyboard-avoidance WebView metrics', () => {
  it('classifies real xterm text and styled whitespace by rendered visibility', async () => {
    const cases = [
      { name: 'default spaces', data: '     ', expected: 0 },
      { name: 'text', data: 'footer', expected: 7 },
      { name: 'background', data: '\x1b[41m     \x1b[0m', expected: 7 },
      { name: 'inverse', data: '\x1b[7m     \x1b[0m', expected: 7 },
      { name: 'underline', data: '\x1b[4m     \x1b[0m', expected: 7 },
      { name: 'strikethrough', data: '\x1b[9m     \x1b[0m', expected: 7 },
      { name: 'overline', data: '\x1b[53m     \x1b[0m', expected: 7 },
      // Hidden text still occupies TUI layout and must count toward keyboard avoidance.
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

  it('reports the row pitch as drawn, fit scale included, and none before a cell is measured', () => {
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
