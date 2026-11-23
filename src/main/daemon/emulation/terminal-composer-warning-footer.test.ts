import { expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import {
  detectTerminalComposerDraft,
  readTerminalComposerTypedText,
  readClippedCodexComposerDraft
} from '../../../shared/terminal/input/terminal-composer-draft'

it.each([
  { bold: true, footer: '\u26a0 1 warning · f2 to view', draft: 'Draft\ncontinuation' },
  { bold: true, footer: '? for shortcuts', draft: 'Draft\ncontinuation' },
  { bold: false, footer: '\u26a0 1 warning · f2 to view', draft: undefined },
  { bold: true, footer: 'Press enter to continue', draft: undefined }
])(
  'requires a Codex composer when only its warning footer fits: $bold $footer',
  async ({ bold, footer, draft }) => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 5 })
    try {
      await emulator.write(
        `${bold ? '\x1b[1m' : ''}›\x1b[0m Draft\r\n  continuation\r\n\r\n\r\n  ${footer}\x1b[3;1H\x1b[?25h`
      )
      expect(detectTerminalComposerDraft(emulator.getCursorLineContext())?.text).toBe(draft)
    } finally {
      emulator.dispose()
    }
  }
)

it('recognizes the empty startup composer beside an undimmed shortcut hint', async () => {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 5 })
  try {
    await emulator.write(
      '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\r\n\r\n  ? for shortcuts\x1b[1;3H\x1b[?25h'
    )
    expect(readTerminalComposerTypedText(emulator.getCursorLineContext())).toBe('')
  } finally {
    emulator.dispose()
  }
})

it('keeps a clipped composer out of general draft detection and rejects a dialog below it', async () => {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 5 })
  try {
    await emulator.write(
      '\x1b[1m›\x1b[0m owned paste\r\n  [Pasted Content\r\n  3735 chars]\x1b[4;3H\x1b[?25h'
    )
    const context = emulator.getCursorLineContext()
    expect(readTerminalComposerTypedText(context)).toBeNull()
    expect(readClippedCodexComposerDraft(context)).toContain('3735 chars]')
    await emulator.write('\x1b[5;1HPress enter to continue\x1b[4;3H')
    expect(readClippedCodexComposerDraft(emulator.getCursorLineContext())).toBeNull()
  } finally {
    emulator.dispose()
  }
})
