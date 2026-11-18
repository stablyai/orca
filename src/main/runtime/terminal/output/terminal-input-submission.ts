// oxlint-disable-next-line no-control-regex -- SAFETY: bracketed-paste framing is ESC-based.
const PASTED_TEXT = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g
// oxlint-disable-next-line no-control-regex -- SAFETY: Alt/Shift+Enter arrive as ESC CR.
const PLAIN_ENTER = /(?:^|[^\x1b])\r/

/** Enter submits a line; pasted text and Alt/Shift+Enter (ESC CR) only edit the draft. */
export function isSubmittedTerminalInput(data: string): boolean {
  return PLAIN_ENTER.test(data.replace(PASTED_TEXT, ''))
}
