import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_KEYBOARD_AVOIDANCE_METRICS_JS } from './terminal-keyboard-avoidance-metrics-injected'
import { parseTerminalKeyboardAvoidanceMetrics } from './terminal-webview-contract'
import { readTerminalWebViewHtmlSource } from './terminal-webview-html-source.test-support'

const terminalHtmlSource = readTerminalWebViewHtmlSource()
const reflowSource = readFileSync(
  new URL('./terminal-webview-reflow-injected.ts', import.meta.url),
  'utf8'
)

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
  const notifications: Record<string, unknown>[] = []
  const buffer = {
    cursorY: 2,
    viewportY: 3,
    type: altScreen ? 'alternate' : 'normal',
    getLine: (index: number) => lines[index - 3],
    getNullCell: () => ({})
  }
  const context = {
    notifications,
    notify: (message: Record<string, unknown>) => notifications.push(message),
    term: { buffer: { active: buffer }, cols: 10, rows: lines.length }
  }
  new Script(
    `${TERMINAL_KEYBOARD_AVOIDANCE_METRICS_JS}\nemitKeyboardAvoidanceMetrics();`
  ).runInNewContext(context)
  return notifications[0] as MetricsNotification
}

function runTerminalMetrics(term: Terminal) {
  const notifications: Record<string, unknown>[] = []
  new Script(
    `${TERMINAL_KEYBOARD_AVOIDANCE_METRICS_JS}\nemitKeyboardAvoidanceMetrics();`
  ).runInNewContext({
    notify: (message: Record<string, unknown>) => notifications.push(message),
    term
  })
  return notifications[0] as MetricsNotification
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
    const resizeStart = terminalHtmlSource.indexOf('  function resize(cols, rows)')
    const resizeEnd = terminalHtmlSource.indexOf('\n  // reflow()', resizeStart)
    const clearStart = terminalHtmlSource.indexOf("} else if (msg.type === 'clear') {")
    const clearEnd = terminalHtmlSource.indexOf("} else if (msg.type === 'measure')", clearStart)
    const textScaleStart = terminalHtmlSource.indexOf('  function applyTextScale(scale)')
    const textScaleEnd = terminalHtmlSource.indexOf('\n  var panX', textScaleStart)

    for (const block of [
      terminalHtmlSource.slice(resizeStart, resizeEnd),
      terminalHtmlSource.slice(clearStart, clearEnd),
      terminalHtmlSource.slice(textScaleStart, textScaleEnd),
      reflowSource
    ]) {
      expect(block.indexOf('emitKeyboardAvoidanceMetrics()')).toBeGreaterThan(
        block.includes('term.resize') ? block.indexOf('term.resize') : block.indexOf('term.reset')
      )
    }
  })
})
