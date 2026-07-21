import { win32 } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import type { NativeImage } from 'electron'
import {
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../shared/clipboard-image'

type ClipboardImageFileHandle = Pick<FileHandle, 'close' | 'read' | 'stat'>

type WindowsClipboardImageFileDeps = {
  createImageFromBuffer: (buffer: Buffer) => NativeImage
  openFile: (filePath: string) => Promise<ClipboardImageFileHandle>
}

type WindowsClipboardImageFileFormats = {
  fileNameW: Buffer
  shellIdListArray: Buffer
}

const FILE_NAME_W_MAX_BYTES = 64 * 1024
const FILE_READ_MAX_CALLS = 1024
const IMAGE_FILE_EXTENSION_SET = new Set(['.jpeg', '.jpg', '.png'])
const JPEG_DIMENSION_SCAN_MAX_BYTES = 1024 * 1024
const JPEG_DIMENSION_SCAN_MAX_MARKERS = 4096
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

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
  return IMAGE_FILE_EXTENSION_SET.has(win32.extname(filePath).toLowerCase()) ? filePath : null
}

function hasAtMostOneShellItem(value: Buffer): boolean {
  if (value.byteLength === 0) {
    return true
  }
  // Why: Explorer's FileNameW exposes only the first path even when its CIDA has multiple items.
  return value.byteLength >= 12 && value.readUInt32LE(0) === 1
}

function readPngDimensions(source: Buffer): { height: number; width: number } | null {
  if (
    source.byteLength < 24 ||
    !source.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    source.readUInt32BE(8) !== 13 ||
    source.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return null
  }
  return { height: source.readUInt32BE(20), width: source.readUInt32BE(16) }
}

function readJpegDimensions(source: Buffer): { height: number; width: number } | null {
  if (source.byteLength < 4 || source[0] !== 0xff || source[1] !== 0xd8) {
    return null
  }
  let offset = 2
  let markersRead = 0
  const scanEnd = Math.min(source.byteLength, JPEG_DIMENSION_SCAN_MAX_BYTES)
  while (offset < scanEnd && markersRead < JPEG_DIMENSION_SCAN_MAX_MARKERS) {
    while (offset < scanEnd && source[offset] === 0xff) {
      offset += 1
    }
    const marker = source[offset]
    offset += 1
    markersRead += 1
    if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) {
      return null
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue
    }
    if (offset + 2 > source.byteLength) {
      return null
    }
    const segmentLength = source.readUInt16BE(offset)
    if (
      segmentLength < 2 ||
      offset + segmentLength > source.byteLength ||
      offset + segmentLength > scanEnd
    ) {
      return null
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        return null
      }
      return { height: source.readUInt16BE(offset + 3), width: source.readUInt16BE(offset + 5) }
    }
    offset += segmentLength
  }
  return null
}

function readImageDimensions(source: Buffer): { height: number; width: number } | null {
  return readPngDimensions(source) ?? readJpegDimensions(source)
}

async function readStableFile(
  handle: ClipboardImageFileHandle,
  expectedSize: number
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(expectedSize + 1)
  let bytesRead = 0
  let readCalls = 0
  while (bytesRead < buffer.byteLength && readCalls < FILE_READ_MAX_CALLS) {
    const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
    readCalls += 1
    if (result.bytesRead === 0) {
      break
    }
    bytesRead += result.bytesRead
  }
  return bytesRead === expectedSize ? buffer.subarray(0, bytesRead) : null
}

export async function readWindowsClipboardImageFileAsPng(
  { fileNameW, shellIdListArray }: WindowsClipboardImageFileFormats,
  { createImageFromBuffer, openFile }: WindowsClipboardImageFileDeps
): Promise<Buffer | null> {
  if (!hasAtMostOneShellItem(shellIdListArray)) {
    return null
  }
  const filePath = decodeFileNameW(fileNameW)
  if (!filePath) {
    return null
  }

  let handle: ClipboardImageFileHandle
  try {
    // Why: one handle keeps validation and the bounded read on the same file if its path changes.
    handle = await openFile(filePath)
  } catch {
    return null
  }

  let source: Buffer | null = null
  try {
    let file: Awaited<ReturnType<ClipboardImageFileHandle['stat']>>
    try {
      file = await handle.stat()
    } catch {
      return null
    }
    if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size < 0) {
      return null
    }
    assertClipboardImageByteLengthWithinLimit(file.size)
    try {
      source = await readStableFile(handle, file.size)
    } catch {
      return null
    }
  } finally {
    await handle.close().catch(() => {})
  }
  if (!source) {
    return null
  }
  const encodedDimensions = readImageDimensions(source)
  if (!encodedDimensions) {
    return null
  }
  // Why: reject pixel bombs from metadata before NativeImage allocates decoded pixels.
  assertClipboardImageDimensionsWithinLimit(encodedDimensions)

  let image: NativeImage
  try {
    image = createImageFromBuffer(source)
  } catch {
    return null
  }
  if (image.isEmpty()) {
    return null
  }
  assertClipboardImageDimensionsWithinLimit(image.getSize())
  const png = image.toPNG()
  assertClipboardImageByteLengthWithinLimit(png.byteLength)
  return png
}
