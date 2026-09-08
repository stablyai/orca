import type { TerminalModes } from '../terminal/terminal-webview-contract'

export function buildMobileTerminalClipboardTextPayload(
  text: string,
  modes: Pick<TerminalModes, 'bracketedPasteMode' | 'altScreen'> | undefined
): string {
  const wrap = modes?.bracketedPasteMode === true && !modes.altScreen
  // Why: copied text must not terminate paste mode early and turn trailing bytes into commands.
  // eslint-disable-next-line no-control-regex -- intentional bracketed-paste marker stripping
  const sanitized = wrap ? text.replace(/\x1b\[20[01]~/g, '') : text
  return wrap ? `\x1b[200~${sanitized}\x1b[201~` : sanitized
}
