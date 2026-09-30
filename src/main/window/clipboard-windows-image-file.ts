import { win32 } from 'node:path'
import {
  CLIPBOARD_IMAGE_FILE_EXTENSIONS,
  readClipboardImageFileAsPng,
  type ClipboardImageFileDeps
} from './clipboard-image-file-read'

type WindowsClipboardImageFileFormats = {
  fileNameW: Buffer
  shellIdListArray: Buffer
}

const FILE_NAME_W_MAX_BYTES = 64 * 1024

function isOrdinaryUncShare(share: string | undefined): boolean {
  return typeof share === 'string' && share.toLowerCase() !== 'pipe'
}

function isFullyQualifiedWindowsPath(filePath: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(filePath)) {
    return true
  }
  if (/^\\\\\?\\[A-Za-z]:\\/.test(filePath)) {
    return true
  }
  const extendedUnc = /^\\\\\?\\UNC\\[^\\/]+\\([^\\/]+)(?:\\|$)/i.exec(filePath)
  if (extendedUnc) {
    return isOrdinaryUncShare(extendedUnc[1])
  }
  const unc = /^[/\\]{2}(?![?.][/\\])[^/\\]+[/\\]([^/\\]+)(?:[/\\]|$)/.exec(filePath)
  return isOrdinaryUncShare(unc?.[1])
}

function decodeFileNameW(value: Buffer): string | null {
  if (
    value.byteLength < 2 ||
    value.byteLength > FILE_NAME_W_MAX_BYTES ||
    value.byteLength % 2 !== 0 ||
    value.readUInt16LE(value.byteLength - 2) !== 0
  ) {
    return null
  }

  let end = value.byteLength - 2
  while (end >= 2 && value.readUInt16LE(end - 2) === 0) {
    end -= 2
  }
  const filePath = value.subarray(0, end).toString('utf16le')
  if (!filePath || filePath.includes('\0') || !isFullyQualifiedWindowsPath(filePath)) {
    return null
  }
  return CLIPBOARD_IMAGE_FILE_EXTENSIONS.has(win32.extname(filePath).toLowerCase())
    ? filePath
    : null
}

function hasAtMostOneShellItem(value: Buffer): boolean {
  if (value.byteLength === 0) {
    return true
  }
  // Why: Explorer's FileNameW exposes only the first path even when its CIDA has multiple items.
  return value.byteLength >= 12 && value.readUInt32LE(0) === 1
}

export async function readWindowsClipboardImageFileAsPng(
  { fileNameW, shellIdListArray }: WindowsClipboardImageFileFormats,
  deps: ClipboardImageFileDeps
): Promise<Buffer | null> {
  if (!hasAtMostOneShellItem(shellIdListArray)) {
    return null
  }
  const filePath = decodeFileNameW(fileNameW)
  if (!filePath) {
    return null
  }
  return readClipboardImageFileAsPng(filePath, deps)
}
