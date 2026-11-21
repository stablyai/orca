// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { createTerminalDocumentScope } from '../document/document-scope'
import { emitKeyboardAvoidanceMetrics } from '../document/viewport/keyboard-avoidance-metrics'
import { commitFitScale } from '../document/viewport/fit-scale'

function runMetricsOver(term: Terminal): Record<string, unknown>[] {
  const notifications: Record<string, unknown>[] = []
  const scope = createTerminalDocumentScope({
    postToHost: (message) => notifications.push(message)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm supplies the public buffer members read by the metrics scan.
  scope.term = term as unknown as typeof scope.term
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

  it('reports row pitch as cells are measured and the fit scale changes', () => {
    const notifications: Record<string, unknown>[] = []
    const scope = createTerminalDocumentScope({
      postToHost: (message) => notifications.push(message),
      viewportRect: () => ({ left: 0, top: 0, width: 320, height: 700 })
    })
    const buffer = { cursorY: 0, viewportY: 0, type: 'normal', getLine: () => undefined }
    const dimensions = { css: { cell: { width: 0, height: 0 } } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements every member the fit and the metrics read.
    scope.term = {
      buffer: { active: buffer },
      cols: 80,
      rows: 40,
      element: { scrollWidth: 640 },
      _core: { _renderService: { dimensions } }
    } as unknown as typeof scope.term
    scope.surface = document.createElement('div')

    emitKeyboardAvoidanceMetrics(scope)
    dimensions.css.cell = { width: 8, height: 15 }
    emitKeyboardAvoidanceMetrics(scope)
    commitFitScale(scope, 'test', 0, 'test')

    const metrics = notifications.filter((message) => message.type === 'keyboard-avoidance-metrics')
    expect(metrics.map((message) => message.rowPitch)).toEqual([0, 15, 7.5])
  })
})
