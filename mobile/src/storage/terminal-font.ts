import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import { encodeBase64 } from '../mobile-web-shell/bridge/bridge-screencast-encoder'
import type { TerminalCustomFont } from '../terminal/document/terminal-font'
import { persistMirrored } from './mirrored-storage-keys'
import {
  TERMINAL_FONT_FILE_NAME_PATTERN,
  TERMINAL_FONT_KEY,
  TERMINAL_FONT_MIME_BY_EXTENSION,
  terminalFontExtension,
  type TerminalFontPreference
} from './terminal-font-preference'

export { loadTerminalFont, type TerminalFontPreference } from './terminal-font-preference'

export const TERMINAL_FONT_IMPORT_SUPPORTED = true

const FONT_DIRECTORY_NAME = 'terminal-fonts'

// Why a ceiling: the page pulls the whole file across the bridge, and every pane renders it.
export const MAX_TERMINAL_FONT_BYTES = 10 * 1024 * 1024

export type TerminalFontImportResult =
  | { status: 'imported'; font: TerminalFontPreference }
  | { status: 'canceled' }
  | { status: 'unsupported' }
  | { status: 'too-large' }

function fontDirectory(): Directory {
  return new Directory(Paths.document, FONT_DIRECTORY_NAME)
}

/** The stored font as the terminal document takes it; null when the file is gone or unreadable. */
export async function readTerminalFontSource(
  font: TerminalFontPreference
): Promise<TerminalCustomFont> {
  const extension = terminalFontExtension(font.fileName)
  if (!extension) {
    return null
  }
  try {
    const file = new File(fontDirectory(), font.fileName)
    if (!file.exists) {
      return null
    }
    const base64 = await file.base64()
    return { source: `data:${TERMINAL_FONT_MIME_BY_EXTENSION[extension]};base64,${base64}` }
  } catch {
    return null
  }
}

/** One range of a stored font for `native.font.read`, base64 for the wire. */
export function readTerminalFontChunk(
  fileName: string,
  offset: number,
  length: number
): { size: number; base64: string } {
  if (!TERMINAL_FONT_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error('not a terminal font this app stored')
  }
  const handle = new File(fontDirectory(), fileName).open()
  try {
    const size = handle.size ?? 0
    handle.offset = Math.min(offset, size)
    const bytes =
      offset < size ? handle.readBytes(Math.min(length, size - offset)) : new Uint8Array()
    return { size, base64: encodeBase64(bytes) }
  } finally {
    handle.close()
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
    const extension = terminalFontExtension(asset.name)
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
    // Mirrored: the page's next `init` carries the choice synchronously.
    await persistMirrored(TERMINAL_FONT_KEY, JSON.stringify(font))
    deleteFontFilesExcept(fileName)
    return { status: 'imported', font }
  } finally {
    try {
      staged.delete()
    } catch {}
  }
}

export async function clearTerminalFont(): Promise<void> {
  await persistMirrored(TERMINAL_FONT_KEY, null)
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
