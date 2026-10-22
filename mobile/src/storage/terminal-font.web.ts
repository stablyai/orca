import type { TerminalCustomFont } from '../terminal/document/terminal-font'
import type { TerminalFontImportResult, TerminalFontPreference } from './terminal-font'

// The page shell has no app-owned file store to keep an imported font in.
export const TERMINAL_FONT_IMPORT_SUPPORTED = false

export async function loadTerminalFont(): Promise<TerminalFontPreference | null> {
  return null
}

export async function readTerminalFontSource(
  _font: TerminalFontPreference
): Promise<TerminalCustomFont> {
  return null
}

export async function importTerminalFont(): Promise<TerminalFontImportResult> {
  return { status: 'unsupported' }
}

export async function clearTerminalFont(): Promise<void> {}
