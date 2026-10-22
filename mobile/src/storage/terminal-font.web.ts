import type { TerminalFontImportResult } from './terminal-font'

export { loadTerminalFont, type TerminalFontPreference } from './terminal-font-preference'

// Imports run in the shell's own settings screen; the page only reads the choice.
export const TERMINAL_FONT_IMPORT_SUPPORTED = false

export const MAX_TERMINAL_FONT_BYTES = 0

export async function importTerminalFont(): Promise<TerminalFontImportResult> {
  return { status: 'unsupported' }
}

export async function clearTerminalFont(): Promise<void> {}
