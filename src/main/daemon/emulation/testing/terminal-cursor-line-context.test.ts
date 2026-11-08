import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  detectTerminalComposerDraft,
  hasTerminalComposerPlaceholder,
  readTerminalComposerTypedText
} from '../../../../shared/terminal/input/terminal-composer-draft'
import { HeadlessEmulator } from '../headless-emulator'
import { readTerminalCursorLineContext } from '../../../../shared/terminal/input/terminal-cursor-line-context'
import { readRuntimeFixture } from '../../../runtime/terminal/wait/agent-transcript-replay-test-harness'

function writeSync(terminal: Terminal, data: string): void {
  const core = (terminal as unknown as { _core: { writeSync(data: string): void } })._core
  core.writeSync(data)
}

describe('readTerminalCursorLineContext', () => {
  it.each([
    { fixture: 'claude-2-1-316-labelled-empty', cursorHidden: false },
    { fixture: 'claude-2-1-316-default-unlabelled-empty', cursorHidden: true }
  ])(
    'keeps recorded empty Claude composer $fixture out of draft and placeholder metadata',
    async ({ fixture, cursorHidden }) => {
      const emulator = new HeadlessEmulator({ cols: 100, rows: 30 })
      try {
        await emulator.write(readRuntimeFixture(fixture))
        const context = emulator.getCursorLineContext()
        expect(context?.cursorHidden).toBe(cursorHidden)
        expect(context?.rows.at(-2)).toMatch(/^─{8,}/)
        expect(detectTerminalComposerDraft(context)).toBeNull()
        expect(hasTerminalComposerPlaceholder(context)).toBe(false)
      } finally {
        emulator.dispose()
      }
    }
  )

  const MULTILINE_DRAFT =
    'Refactor the login page so that it preserves the existing authentication behavior and includes\nthe coverage report'

  it.each([
    {
      fixture: 'claude-2-1-316-default-labelled-middle',
      cursorInverse: true,
      draft: { text: MULTILINE_DRAFT, promptRow: 8, cursorRow: 9, endRow: 9 }
    },
    {
      fixture: 'claude-2-1-316-default-unlabelled-middle',
      cursorInverse: true,
      draft: { text: MULTILINE_DRAFT, promptRow: 8, cursorRow: 9, endRow: 9 }
    },
    {
      // Focus-out drops the painted caret; the hidden cursor stays parked mid-draft.
      fixture: 'claude-2-1-316-default-labelled-blurred',
      cursorInverse: false,
      draft: { text: 'Refactor the login page so that it', promptRow: 8, cursorRow: 8, endRow: 8 }
    }
  ])(
    "reads Claude's default hidden caret inside $fixture",
    async ({ fixture, cursorInverse, draft }) => {
      const emulator = new HeadlessEmulator({ cols: 100, rows: 30 })
      try {
        await emulator.write(readRuntimeFixture(fixture))
        const context = emulator.getCursorLineContext()
        expect(context).toMatchObject({ cursorHidden: true, activeBuffer: 'normal', cursorInverse })
        expect(detectTerminalComposerDraft(context)).toEqual({ ...draft, promptGlyph: '❯' })
      } finally {
        emulator.dispose()
      }
    }
  )

  it.each([
    // Claude's alternate-screen redraw parks the hidden cursor in a complete box without caret paint.
    { fixture: 'claude-interrupt-tool-cancel-supported', length: 1321, completeFrame: true },
    // The dsh first-run guide redraws its text between rules with the cursor hidden.
    { fixture: 'dsh-tui-0.17/first-run-guide', length: 10355, completeFrame: false }
  ])(
    'leaves an alternate-screen hidden cursor without caret paint out of drafts in $fixture',
    async ({ fixture, length, completeFrame }) => {
      const emulator = new HeadlessEmulator({ cols: 120, rows: 40 })
      try {
        await emulator.write(readRuntimeFixture(fixture).slice(0, length))
        const context = emulator.getCursorLineContext()
        expect(context).toMatchObject({
          cursorHidden: true,
          activeBuffer: 'alternate',
          cursorInverse: false
        })
        expect(detectTerminalComposerDraft(context)).toBeNull()
        if (completeFrame && context) {
          // The buffer type alone keeps this otherwise complete frame out.
          expect(detectTerminalComposerDraft({ ...context, activeBuffer: 'normal' })?.text).toMatch(
            /^Use/
          )
        }
      } finally {
        emulator.dispose()
      }
    }
  )

  it('reads input rows below the cursor while the viewport is scrolled into history', () => {
    const terminal = new Terminal({ cols: 30, rows: 9, scrollback: 100, allowProposedApi: true })
    try {
      const history = Array.from({ length: 50 }, (_, row) => `history ${row}`).join('\r\n')
      writeSync(
        terminal,
        `${history}\r\n${'─'.repeat(20)}\r\n\x1b[1m❯\x1b[22m first line\x1b7\r\n  second line\r\n  third line\r\n${'─'.repeat(20)}\x1b8`
      )
      terminal.scrollLines(-8)
      expect(terminal.buffer.active.viewportY).toBeLessThan(terminal.buffer.active.baseY)
      expect(
        readTerminalComposerTypedText(readTerminalCursorLineContext(terminal, terminal.rows))
      ).toBe('first line\nsecond line\nthird line')
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

  it('finds a composer prompt more than 16 wrapped rows above the cursor', async () => {
    const draft = `proceed ${'with '.repeat(65)}release`
    const emulator = new HeadlessEmulator({ cols: 19, rows: 30 })
    await emulator.write(`${'─'.repeat(19)}\r\n❯ ${draft}`)

    const context = emulator.getCursorLineContext()

    expect(context?.rows.length).toBeGreaterThan(17)
    expect(detectTerminalComposerDraft(context)?.text).toBe(draft)
    emulator.dispose()
  })

  it('keeps an unwritten cell between typed glyphs as a space', () => {
    const terminal = new Terminal({ cols: 12, rows: 5, allowProposedApi: true })
    try {
      writeSync(terminal, 'a\x1b[3Gb')
      expect(readTerminalCursorLineContext(terminal, terminal.rows)?.typedRows).toEqual(['a b'])
    } finally {
      terminal.dispose()
    }
  })
})
