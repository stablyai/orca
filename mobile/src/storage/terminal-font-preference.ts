import AsyncStorage from '@react-native-async-storage/async-storage'

/** Mirrored to the page, which reads the choice and fetches the file over `native.font.read`. */
export const TERMINAL_FONT_KEY = 'orca:terminalFont'

export const TERMINAL_FONT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2'
}

/** Only names this app writes, so a page cannot ask the shell for any other file. */
export const TERMINAL_FONT_FILE_NAME_PATTERN = /^font-\d+\.(ttf|otf|woff|woff2)$/

/** The imported font as stored: the name the user picked and the copy this app owns. */
export type TerminalFontPreference = { name: string; fileName: string }

export function terminalFontExtension(name: string): string | null {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return extension in TERMINAL_FONT_MIME_BY_EXTENSION ? extension : null
}

export function parseTerminalFontPreference(raw: string | null): TerminalFontPreference | null {
  if (raw === null) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'name' in parsed &&
      'fileName' in parsed &&
      typeof parsed.name === 'string' &&
      typeof parsed.fileName === 'string' &&
      TERMINAL_FONT_FILE_NAME_PATTERN.test(parsed.fileName)
    ) {
      return { name: parsed.name, fileName: parsed.fileName }
    }
  } catch {}
  return null
}

export async function loadTerminalFont(): Promise<TerminalFontPreference | null> {
  try {
    return parseTerminalFontPreference(await AsyncStorage.getItem(TERMINAL_FONT_KEY))
  } catch {
    return null
  }
}
