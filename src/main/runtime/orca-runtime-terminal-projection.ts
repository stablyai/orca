import { detectTerminalComposerDraft } from '../../shared/terminal-composer-draft'
import {
  collapseTerminalComposerDraftRows,
  visibleNonBlankTerminalLines
} from '../../shared/terminal-visible-screen-projection'
import type { HeadlessEmulator } from '../daemon/headless-emulator'

export function projectTerminalTailLines(
  emulator: HeadlessEmulator,
  limit: number
): { lines: string[]; draft?: string } {
  const tail = emulator.getBufferTailLines(limit)
  const visible = emulator.getVisibleLines()
  const visibleRange = emulator.getVisibleBufferRange()
  const draft = detectTerminalComposerDraft(emulator.getCursorLineContext())
  if (draft && visibleRange.endExclusive === visibleRange.totalLength) {
    visible[draft.promptRow] = draft.promptGlyph
    for (let row = draft.promptRow + 1; row <= draft.endRow; row += 1) {
      visible[row] = ''
    }
    const scrollbackTail = tail.slice(0, Math.max(0, tail.length - visible.length))
    tail.splice(0, tail.length, ...scrollbackTail, ...visibleNonBlankTerminalLines(visible))
  }
  return {
    lines: visibleNonBlankTerminalLines(tail).slice(-limit),
    ...(draft ? { draft: draft.text } : {})
  }
}

export function projectTerminalVisibleLines(emulator: HeadlessEmulator): {
  lines: string[]
  draft?: string
} {
  return collapseTerminalComposerDraftRows(
    emulator.getVisibleLines(),
    detectTerminalComposerDraft(emulator.getCursorLineContext())
  )
}
