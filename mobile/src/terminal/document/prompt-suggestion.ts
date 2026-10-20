import { readClaudeTerminalPromptSuggestion } from '../../../../src/shared/claude-terminal-prompt-suggestion'
import type { TerminalCursorContextSource } from '../../../../src/shared/terminal-cursor-line-context'
import type { TerminalDocumentTerminal } from './document-terminal-shape'
import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import { afterWritesDrained } from './write-queue'

function hasCursorCells(
  terminal: TerminalDocumentTerminal
): terminal is TerminalDocumentTerminal & TerminalCursorContextSource {
  const buffer = terminal.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  const cell = buffer.getNullCell?.()
  return !!(
    terminal.modes &&
    'showCursor' in terminal.modes &&
    typeof terminal.modes.showCursor === 'boolean' &&
    'cursorX' in buffer &&
    typeof buffer.cursorX === 'number' &&
    line?.getCell &&
    'isWrapped' in line &&
    typeof line.isWrapped === 'boolean' &&
    cell &&
    'getChars' in cell &&
    typeof cell.getChars === 'function' &&
    'getWidth' in cell &&
    typeof cell.getWidth === 'function' &&
    'isDim' in cell &&
    typeof cell.isDim === 'function' &&
    'isBold' in cell &&
    typeof cell.isBold === 'function' &&
    'isFgDefault' in cell &&
    typeof cell.isFgDefault === 'function'
  )
}

export function replyPromptSuggestion(scope: TerminalDocumentScope, requestId: number): void {
  if (!scope.ready) {
    notify(scope, { type: 'prompt-suggestion', requestId, text: null })
    return
  }
  const generation = scope.terminalGeneration
  afterWritesDrained(scope, () => {
    const terminal = scope.term
    const text =
      scope.ready && generation === scope.terminalGeneration && terminal && hasCursorCells(terminal)
        ? readClaudeTerminalPromptSuggestion(terminal)
        : null
    notify(scope, { type: 'prompt-suggestion', requestId, text })
  })
}
