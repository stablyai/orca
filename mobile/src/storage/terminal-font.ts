import AsyncStorage from '@react-native-async-storage/async-storage'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import type { TerminalCustomFont } from '../terminal/document/terminal-font'

export const TERMINAL_FONT_IMPORT_SUPPORTED = true

const TERMINAL_FONT_KEY = 'orca:terminalFont'
const FONT_DIRECTORY_NAME = 'terminal-fonts'

// Why a ceiling: every terminal pane receives the whole file over the WebView bridge.
export const MAX_TERMINAL_FONT_BYTES = 10 * 1024 * 1024

const FONT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2'
}

/** The imported font as stored: the name the user picked and the copy this app owns. */
export type TerminalFontPreference = { name: string; fileName: string }

export type TerminalFontImportResult =
  | { status: 'imported'; font: TerminalFontPreference }
  | { status: 'canceled' }
  | { status: 'unsupported' }
  | { status: 'too-large' }

function fontExtension(name: string): string | null {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return extension in FONT_MIME_BY_EXTENSION ? extension : null
}

function fontDirectory(): Directory {
  return new Directory(Paths.document, FONT_DIRECTORY_NAME)
}

export async function loadTerminalFont(): Promise<TerminalFontPreference | null> {
  try {
    const raw = await AsyncStorage.getItem(TERMINAL_FONT_KEY)
    if (raw === null) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'name' in parsed &&
      'fileName' in parsed &&
      typeof parsed.name === 'string' &&
      typeof parsed.fileName === 'string' &&
      fontExtension(parsed.fileName)
    ) {
      return { name: parsed.name, fileName: parsed.fileName }
    }
    return null
  } catch {
    return null
  }
}

/** The stored font as the terminal document takes it; null when the file is gone or unreadable. */
export async function readTerminalFontSource(
  font: TerminalFontPreference
): Promise<TerminalCustomFont> {
  const extension = fontExtension(font.fileName)
  if (!extension) {
    return null
  }
  try {
    const file = new File(fontDirectory(), font.fileName)
    if (!file.exists) {
      return null
    }
    const base64 = await file.base64()
    return { source: `data:${FONT_MIME_BY_EXTENSION[extension]};base64,${base64}` }
  } catch {
    return null
  }
}

export async function importTerminalFont(): Promise<TerminalFontImportResult> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: false,
    copyToCacheDirectory: true
  })
  const asset = picked.canceled ? null : picked.assets[0]
  if (!asset) {
    return { status: 'canceled' }
  }
  const staged = new File(asset.uri)
  try {
    const extension = fontExtension(asset.name)
    if (!extension) {
      return { status: 'unsupported' }
    }
    if ((asset.size ?? staged.size) > MAX_TERMINAL_FONT_BYTES) {
      return { status: 'too-large' }
    }
    const directory = fontDirectory()
    directory.create({ intermediates: true, idempotent: true })
    // Why a fresh name: a pane may still be loading the previous file when this one lands.
    const fileName = `font-${Date.now()}.${extension}`
    staged.copy(new File(directory, fileName))
    const font = { name: asset.name.replace(/\.[^.]+$/, ''), fileName }
    await AsyncStorage.setItem(TERMINAL_FONT_KEY, JSON.stringify(font))
    deleteFontFilesExcept(fileName)
    return { status: 'imported', font }
  } finally {
    try {
      staged.delete()
    } catch {}
  }
}

export async function clearTerminalFont(): Promise<void> {
  await AsyncStorage.removeItem(TERMINAL_FONT_KEY)
  deleteFontFilesExcept(null)
}

function deleteFontFilesExcept(keep: string | null) {
  try {
    for (const entry of fontDirectory().list()) {
      if (entry instanceof File && entry.name !== keep) {
        entry.delete()
      }
    }
  } catch {}
}
