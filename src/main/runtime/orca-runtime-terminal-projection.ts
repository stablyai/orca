import { detectTerminalComposerDraft } from '../../shared/terminal-composer-draft'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import { visibleNonBlankTerminalLines } from './terminal-tail-read'

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
  const visible = emulator.getVisibleLines()
  const draft = detectTerminalComposerDraft(emulator.getCursorLineContext())
  if (draft) {
    visible[draft.promptRow] = draft.promptGlyph
    for (let row = draft.promptRow + 1; row <= draft.endRow; row += 1) {
      visible[row] = ''
    }
  }
  return {
    lines: visibleNonBlankTerminalLines(visible),
    ...(draft ? { draft: draft.text } : {})
  }
}

const PROJECTED_PROMPT_GLYPHS: ReadonlySet<string> = new Set(['❯', '›', '»'])

/** Undoes the projection's draft blanking, for rules that read the rows the TUI painted. */
export function restoreProjectedComposerDraft(
  lines: readonly string[],
  draft: string | undefined
): string[] {
  const promptRow = draft ? lines.findLastIndex((line) => PROJECTED_PROMPT_GLYPHS.has(line)) : -1
  if (draft === undefined || promptRow === -1) {
    return [...lines]
  }
  const [first = '', ...rest] = draft.split('\n')
  return [
    ...lines.slice(0, promptRow),
    `${lines[promptRow]} ${first}`,
    ...rest,
    ...lines.slice(promptRow + 1)
  ]
}
