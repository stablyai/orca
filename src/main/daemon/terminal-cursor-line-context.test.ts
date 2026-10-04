import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { detectTerminalComposerDraft } from '../../shared/terminal-composer-draft'
import { HeadlessEmulator } from './headless-emulator'
import { readTerminalCursorLineContext } from '../../shared/terminal-cursor-line-context'

function writeSync(terminal: Terminal, data: string): void {
  const core = (terminal as unknown as { _core: { writeSync(data: string): void } })._core
  core.writeSync(data)
}

type Cell = ReturnType<Terminal['buffer']['active']['getNullCell']>

function observeCellReads(terminal: Terminal) {
  const allocated: Cell[] = []
  const targets: (Cell | undefined)[] = []
  const active = terminal.buffer.active
  const source = {
    rows: terminal.rows,
    modes: terminal.modes,
    buffer: {
      active: {
        baseY: active.baseY,
        cursorX: active.cursorX,
        cursorY: active.cursorY,
        viewportY: active.viewportY,
        getNullCell: () => {
          const cell = active.getNullCell()
          allocated.push(cell)
          return cell
        },
        getLine: (row: number) => {
          const line = active.getLine(row)
          if (!line) {
            return undefined
          }
          return {
            isWrapped: line.isWrapped,
            length: line.length,
            translateToString: line.translateToString.bind(line),
            getCell: (column: number, reusableCell?: Cell) => {
              targets.push(reusableCell)
              return line.getCell(column, reusableCell)
            }
          }
        }
      }
    }
  }
  return { source, allocated, targets }
}

describe('readTerminalCursorLineContext', () => {
  it('reuses one cell across every scan without retaining it between reads', () => {
    const terminal = new Terminal({ cols: 12, rows: 5, allowProposedApi: true })
    try {
      writeSync(terminal, '\x1b[1m❯\x1b[22m 界e\u0301\x1b7\r\n\x1b[31mfooter\x1b8')
      const rig = observeCellReads(terminal)
      const first = readTerminalCursorLineContext(rig.source, terminal.rows)
      expect(rig.allocated).toHaveLength(1)
      expect(rig.targets.length).toBeGreaterThan(terminal.cols * 2)
      expect(rig.targets.every((cell) => cell === rig.allocated[0])).toBe(true)
      rig.targets.length = 0
      expect(readTerminalCursorLineContext(rig.source, terminal.rows)).toEqual(first)
      expect(rig.allocated).toHaveLength(2)
      expect(rig.allocated[1]).not.toBe(rig.allocated[0])
      expect(rig.targets.every((cell) => cell === rig.allocated[1])).toBe(true)
    } finally {
      terminal.dispose()
    }
  })

  it('preserves full context for an adapter without reusable cells', () => {
    const terminal = new Terminal({ cols: 12, rows: 5, allowProposedApi: true })
    try {
      writeSync(
        terminal,
        '\x1b[1m❯\x1b[22m typed\x1b7\x1b[2m hint\x1b[22m\r\n\x1b[38;2;1;2;3m界e\u0301\x1b[0m\x1b8'
      )
      const rig = observeCellReads(terminal)
      const source = {
        ...rig.source,
        buffer: { active: { ...rig.source.buffer.active, getNullCell: undefined } }
      }
      const context = readTerminalCursorLineContext(source, terminal.rows)
      expect(context).toEqual(readTerminalCursorLineContext(terminal, terminal.rows))
      expect(context?.typedRows).toEqual(['❯ typed'])
      expect(context?.typedRowsBelow[0]).toBe('界e\u0301')
      expect(context?.beforeCursor).toBe('❯ typed')
      expect(context?.afterCursor).toBe('')
      expect(context?.rawAfterCursor).toBe(' hint')
      expect(context?.promptGlyphBoldRows).toEqual([true])
      expect(context?.rowsBelowCustomForeground?.[0]).toBe(true)
      expect(rig.allocated).toEqual([])
      expect(rig.targets.length).toBeGreaterThan(terminal.cols * 2)
      expect(rig.targets.every((cell) => cell === undefined)).toBe(true)
    } finally {
      terminal.dispose()
    }
  })

  it.each([
    { cols: 19, cursorRowTail: 'proceed with the ', continuation: 'release' },
    { cols: 18, cursorRowTail: 'proceed with the', continuation: ' release' }
  ])(
    'preserves a space at a dimmed soft-wrap boundary with $cols columns',
    ({ cols, cursorRowTail, continuation }) => {
      const terminal = new Terminal({ cols, rows: 6, allowProposedApi: true })
      writeSync(
        terminal,
        `${'─'.repeat(cols)}\r\n❯ \x1b7\x1b[2mproceed with the release\x1b[22m\x1b8`
      )

      const context = readTerminalCursorLineContext(terminal, 16)

      expect(context?.rawAfterCursor).toBe(cursorRowTail)
      expect(context?.rowsBelow).toEqual([continuation, '', '', ''])
      expect(context?.rowsBelowWrapped).toEqual([true, false, false, false])
      expect(detectTerminalComposerDraft(context)?.text).toBe('proceed with the release')
      terminal.dispose()
    }
  )

  it('preserves a typed space before the cursor moves onto a wrapped row', () => {
    const terminal = new Terminal({ cols: 19, rows: 6, allowProposedApi: true })
    writeSync(terminal, '───────────────────\r\n❯ proceed with the release')

    const context = readTerminalCursorLineContext(terminal, 16)

    expect(context?.typedRows).toEqual(['───────────────────', '❯ proceed with the ', 'release'])
    expect(context?.rowsWrapped).toEqual([false, false, true])
    expect(detectTerminalComposerDraft(context)?.text).toBe('proceed with the release')
    terminal.dispose()
  })

  it('recognizes a colored context-only Codex status footer', () => {
    const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true })
    writeSync(
      terminal,
      '\x1b[1m›\x1b[22m \x1b7review the change\r\n \r\n\x1b[38;2;242;181;144mContext 0% used\x1b[0m\x1b8'
    )

    const context = readTerminalCursorLineContext(terminal, 16)

    expect(detectTerminalComposerDraft(context)?.text).toBe('review the change')
    terminal.dispose()
  })

  it('finds a composer prompt more than 16 wrapped rows above the cursor', async () => {
    const draft = `proceed ${'with '.repeat(65)}release`
    const emulator = new HeadlessEmulator({ cols: 19, rows: 30 })
    await emulator.write(`${'─'.repeat(19)}\r\n❯ ${draft}`)

    const context = emulator.getCursorLineContext()

    expect(context?.rows.length).toBeGreaterThan(17)
    expect(detectTerminalComposerDraft(context)?.text).toBe(draft)
    emulator.dispose()
  })
})
