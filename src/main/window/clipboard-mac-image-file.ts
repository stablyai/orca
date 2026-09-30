import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLIPBOARD_IMAGE_FILE_EXTENSIONS,
  readClipboardImageFileAsPng,
  type ClipboardImageFileDeps
} from './clipboard-image-file-read'

type MacClipboardImageFileFormats = {
  fileUrl: string
  filenamesPlist: string
  text: string
}

const FILE_URL_MAX_CHARS = 64 * 1024

function decodeCopiedImageFilePath({
  fileUrl,
  filenamesPlist,
  text
}: MacClipboardImageFileFormats): string | null {
  if (!isMacClipboardFileUrl(fileUrl)) {
    return null
  }
  // Why: public.file-url exposes only the first item of a Finder multi-selection.
  if ((filenamesPlist.match(/<string>/g)?.length ?? 0) > 1) {
    return null
  }
  let filePath: string
  try {
    filePath = fileURLToPath(fileUrl)
  } catch {
    return null
  }
  if (!posix.isAbsolute(filePath)) {
    return null
  }
  if (!CLIPBOARD_IMAGE_FILE_EXTENSIONS.has(posix.extname(filePath).toLowerCase())) {
    return null
  }
  // Why: Finder adds the filename as text (extension dropped when hidden, as for
  // screenshots); any other text is real content to paste.
  const trimmedText = text.trim().normalize('NFC')
  if (trimmedText && !finderFilenameTexts(filePath).has(trimmedText)) {
    return null
  }
  return filePath
}

function finderFilenameTexts(filePath: string): Set<string> {
  // Why: NSURL yields NFD paths while Finder's filename text is NFC.
  const path = filePath.normalize('NFC')
  const name = posix.basename(path)
  return new Set([path, name, name.slice(0, name.length - posix.extname(name).length)])
}

export function isMacClipboardFileUrl(fileUrl: string): boolean {
  return fileUrl.startsWith('file://') && fileUrl.length <= FILE_URL_MAX_CHARS
}

export async function readMacClipboardImageFileAsPng(
  formats: MacClipboardImageFileFormats,
  deps: ClipboardImageFileDeps
): Promise<Buffer | null> {
  const filePath = decodeCopiedImageFilePath(formats)
  return filePath ? readClipboardImageFileAsPng(filePath, deps) : null
}
