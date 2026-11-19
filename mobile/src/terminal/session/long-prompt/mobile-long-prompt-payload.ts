import {
  normalizeTerminalPasteLineEndings,
  wrapTerminalBracketedPasteText
} from '../../../../../src/shared/terminal/input/terminal-bracketed-paste-text'

// Framed the way the Paste action frames, then Enter submits it, so an agent reads one message.
export function buildMobileLongPromptPayload(
  text: string,
  bracketedPasteMode: boolean | undefined
): string {
  if (text.trim() === '') {
    return ''
  }
  const body =
    bracketedPasteMode === true
      ? wrapTerminalBracketedPasteText(text)
      : normalizeTerminalPasteLineEndings(text)
  return `${body}\r`
}
