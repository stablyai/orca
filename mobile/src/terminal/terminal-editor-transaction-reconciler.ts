const TERMINAL_DEL_BYTE = '\x7f'
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export type TerminalEditorTransaction = {
  readonly revision: number
  readonly text: string
  readonly composingStart: number | null
  readonly composingEnd: number | null
}

export type TerminalEditorTransactionState = {
  readonly revision: number
  readonly editorText: string
  readonly terminalText: string
}

export type TerminalEditorTransactionResult = {
  readonly bytes: string
  readonly state: TerminalEditorTransactionState
}

export function createTerminalEditorTransactionState(): TerminalEditorTransactionState {
  return { revision: 0, editorText: '', terminalText: '' }
}

export function applyTerminalEditorTransaction(
  state: TerminalEditorTransactionState,
  transaction: TerminalEditorTransaction
): TerminalEditorTransactionResult {
  if (transaction.revision <= state.revision) {
    return { bytes: '', state }
  }

  const stableText = getStableEditorPrefix(transaction)
  if (transaction.text.startsWith(state.terminalText)) {
    const appendText = stableText.startsWith(state.terminalText)
      ? stableText.slice(state.terminalText.length)
      : ''
    return {
      bytes: appendText,
      state: {
        revision: transaction.revision,
        editorText: transaction.text,
        terminalText: state.terminalText + appendText
      }
    }
  }

  // A mutation of already-delivered text is only a user edit when the prior
  // editor snapshot had no held suffix. IME rewrites never trigger corrective DEL.
  if (state.editorText !== state.terminalText) {
    return {
      bytes: '',
      state: {
        revision: transaction.revision,
        editorText: transaction.text,
        terminalText: state.terminalText
      }
    }
  }

  const commonPrefix = getCommonGraphemePrefix(state.terminalText, transaction.text)
  const eraseCount = countGraphemes(state.terminalText.slice(commonPrefix.length))
  const appendText = stableText.startsWith(commonPrefix)
    ? stableText.slice(commonPrefix.length)
    : ''
  return {
    bytes: TERMINAL_DEL_BYTE.repeat(eraseCount) + appendText,
    state: {
      revision: transaction.revision,
      editorText: transaction.text,
      terminalText: commonPrefix + appendText
    }
  }
}

export function flushTerminalEditorTransaction(
  state: TerminalEditorTransactionState
): TerminalEditorTransactionResult {
  if (!state.editorText.startsWith(state.terminalText)) {
    return { bytes: '', state }
  }
  const appendText = state.editorText.slice(state.terminalText.length)
  return {
    bytes: appendText,
    state: { ...state, terminalText: state.editorText }
  }
}

function getStableEditorPrefix(transaction: TerminalEditorTransaction): string {
  if (
    transaction.composingStart !== null &&
    transaction.composingEnd !== null &&
    transaction.composingStart >= 0 &&
    transaction.composingStart <= transaction.composingEnd &&
    transaction.composingEnd <= transaction.text.length
  ) {
    return transaction.text.slice(0, transaction.composingStart)
  }
  const graphemes = segmentGraphemes(transaction.text)
  return graphemes.slice(0, -1).join('')
}

function getCommonGraphemePrefix(left: string, right: string): string {
  const leftGraphemes = segmentGraphemes(left)
  const rightGraphemes = segmentGraphemes(right)
  let index = 0
  while (
    index < leftGraphemes.length &&
    index < rightGraphemes.length &&
    leftGraphemes[index] === rightGraphemes[index]
  ) {
    index += 1
  }
  return leftGraphemes.slice(0, index).join('')
}

function countGraphemes(text: string): number {
  return segmentGraphemes(text).length
}

function segmentGraphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment)
}
