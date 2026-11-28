import {
  detectTerminalComposerDraft,
  readTerminalComposerTypedText
} from '../../../../shared/terminal/input/terminal-composer-draft'
import type { RuntimeHeadlessTerminal } from '../records/runtime-terminal-state-records'
import type { TerminalInputScreen } from '../lifecycle/terminal-input-observation'
import type { TerminalRunFactsRegister } from '../lifecycle/terminal-run-facts'

export function captureTerminalInputScreen(
  state: Pick<RuntimeHeadlessTerminal, 'emulator' | 'writeChain'> | undefined
): Promise<TerminalInputScreen> {
  if (!state) {
    return Promise.resolve({ draft: null, lines: [] })
  }
  return state.writeChain.then(() => {
    const context = state.emulator.getCursorLineContext()
    if (!context) {
      return { draft: null, lines: [] }
    }
    const draft = readTerminalComposerTypedText(context)
    const composer = detectTerminalComposerDraft(context)
    const range = state.emulator.getVisibleBufferRange()
    const tail = state.emulator.getBufferTailRows(2000)
    const start = range.totalLength - tail.length
    const end = range.start + (composer?.promptRow ?? context.cursorViewportRow)
    const lines: string[] = []
    const kept = tail.slice(0, Math.max(0, end - start))
    kept.forEach((row, index) => {
      if (row.metadata.wrapped && lines.length > 0) {
        lines[lines.length - 1] += ' '.repeat(kept[index - 1].metadata.trailingSpaces) + row.text
      } else {
        lines.push(row.text)
      }
    })
    return { draft, model: state.emulator, lines: draft === null ? [] : lines }
  })
}

export function observeTerminalInputScreen(
  facts: TerminalRunFactsRegister,
  ptyId: string,
  state: Pick<RuntimeHeadlessTerminal, 'emulator' | 'writeChain'> | undefined
): void {
  if (!facts.needsInputScreenObservation(ptyId)) {
    return
  }
  void facts.observeInputScreen(ptyId, captureTerminalInputScreen(state)).catch(() => {})
}
