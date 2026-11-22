import type { FileHandle } from 'node:fs/promises'
import { WINDOWS_PORTABLE_DATA_DIR, WINDOWS_PORTABLE_ROOT_DIR } from './windows-portable-package'

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const UNIX_SYMLINK_MODE = 0o120000
const UNIX_FILE_TYPE_MASK = 0o170000
const ZIP64_EXTRA_ID = 0x0001
const MAX_EOCD_SCAN_BYTES = 65_557

export const MAX_PORTABLE_ZIP_ENTRIES = 16_384
export const MAX_PORTABLE_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024

export type PortableZipEntry = {
  relativePath: string
  isDirectory: boolean
  compressionMethod: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export type PortableZipOptions = {
  rootDir?: string
  maxEntries?: number
  maxPayloadBytes?: number
}

type CentralDirectoryInfo = {
  entryCount: number
  size: number
  offset: number
}

export async function readFileRange(
  handle: FileHandle,
  offset: number,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let totalRead = 0
  while (totalRead < length) {
    const { bytesRead } = await handle.read(buffer, totalRead, length - totalRead, offset + totalRead)
    if (bytesRead === 0) {
      throw new Error('Unexpected end of ZIP archive')
    }
    totalRead += bytesRead
  }
  return buffer
}

async function locateCentralDirectory(
  handle: FileHandle,
  fileSize: number
): Promise<CentralDirectoryInfo> {
  if (fileSize < 22) {
    throw new Error('Portable update archive is truncated')
  }
  const scanLength = Math.min(fileSize, MAX_EOCD_SCAN_BYTES)
  const scanStart = fileSize - scanLength
  const tail = await readFileRange(handle, scanStart, scanLength)

  let eocdOffset = -1
  for (let pos = tail.length - 22; pos >= 0; pos -= 1) {
    if (tail.readUInt32LE(pos) === EOCD_SIGNATURE) {
      const commentLen = tail.readUInt16LE(pos + 20)
      if (pos + 22 + commentLen === tail.length) {
        eocdOffset = pos
        break
      }
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Portable update archive is missing ZIP end-of-central-directory record')
  }

  let entryCount = tail.readUInt16LE(eocdOffset + 10)
  let size = tail.readUInt32LE(eocdOffset + 12)
  let offset = tail.readUInt32LE(eocdOffset + 16)

  if (entryCount === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locatorPos = eocdOffset - 20
    if (locatorPos < 0 || tail.readUInt32LE(locatorPos) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw new Error('Portable update archive is missing ZIP64 locator')
    }
    const zip64Offset = Number(tail.readBigUInt64LE(locatorPos + 8))
    const zip64 = await readFileRange(handle, zip64Offset, 56)
    if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw new Error('Portable update archive has invalid ZIP64 EOCD signature')
    }
    entryCount = Number(zip64.readBigUInt64LE(32))
    size = Number(zip64.readBigUInt64LE(40))
    offset = Number(zip64.readBigUInt64LE(48))
  }

  if (offset < 0 || size < 0 || offset + size > fileSize) {
    throw new Error('Portable update archive central directory exceeds file bounds')
  }
  return { entryCount, size, offset }
}

function readZip64Extra(
  extra: Buffer,
  needUncompressed: boolean,
  needCompressed: boolean,
  needOffset: boolean
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  let pos = 0
  while (pos + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(pos)
    const dataSize = extra.readUInt16LE(pos + 2)
    pos += 4
    if (pos + dataSize > extra.length) {
      break
    }
    if (headerId === ZIP64_EXTRA_ID) {
      let cursor = pos
      const result: {
        uncompressedSize?: number
        compressedSize?: number
        localHeaderOffset?: number
      } = {}
      if (needUncompressed && cursor + 8 <= pos + dataSize) {
        result.uncompressedSize = Number(extra.readBigUInt64LE(cursor))
        cursor += 8
      }
      if (needCompressed && cursor + 8 <= pos + dataSize) {
        result.compressedSize = Number(extra.readBigUInt64LE(cursor))
        cursor += 8
      }
      if (needOffset && cursor + 8 <= pos + dataSize) {
        result.localHeaderOffset = Number(extra.readBigUInt64LE(cursor))
      }
      return result
    }
    pos += dataSize
  }
  return {}
}

const WINDOWS_RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function isUnsafeWindowsSegment(part: string): boolean {
  return (
    part.length === 0 ||
    part === '.' ||
    part === '..' ||
    part.endsWith('.') ||
    part.endsWith(' ') ||
    WINDOWS_RESERVED_DEVICE_RE.test(part)
  )
}

function validateAndStripRoot(rawName: string, isDirectory: boolean, rootDir: string): string {
  if (/[\x00-\x1f\\:]/.test(rawName)) {
    throw new Error(`Portable update archive contains an unsafe path: ${rawName}`)
  }
  const trimmed = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
  const segments = trimmed.split('/')
  if (segments.some(isUnsafeWindowsSegment)) {
    throw new Error(`Portable update archive contains an unsafe path: ${rawName}`)
  }
  if (trimmed === rootDir && isDirectory) {
    return ''
  }
  const prefix = `${rootDir}/`
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`Portable update archive entry is outside ${rootDir}/: ${rawName}`)
  }
  return trimmed.slice(prefix.length)
}

export function isPortableUserDataPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase()
  return lower === WINDOWS_PORTABLE_DATA_DIR || lower.startsWith(`${WINDOWS_PORTABLE_DATA_DIR}/`)
}

export async function readPortableZipEntries(
  handle: FileHandle,
  fileSize: number,
  options: PortableZipOptions = {}
): Promise<PortableZipEntry[]> {
  const rootDir = options.rootDir ?? WINDOWS_PORTABLE_ROOT_DIR
  const maxEntries = options.maxEntries ?? MAX_PORTABLE_ZIP_ENTRIES
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_PORTABLE_PAYLOAD_BYTES

  const cdInfo = await locateCentralDirectory(handle, fileSize)
  if (cdInfo.entryCount > maxEntries) {
    throw new Error(`Portable update archive exceeds entry limit (${cdInfo.entryCount})`)
  }
  const buffer = await readFileRange(handle, cdInfo.offset, cdInfo.size)
  const entries: PortableZipEntry[] = []
  const seenLower = new Set<string>()
  let pos = 0
  let totalUncompressed = 0

  while (pos < buffer.length) {
    if (entries.length >= cdInfo.entryCount) {
      throw new Error('Portable update archive central directory entry count mismatch')
    }
    if (entries.length >= maxEntries) {
      throw new Error(`Portable update archive exceeds entry limit (${maxEntries})`)
    }
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error('Portable update archive has corrupt central directory record')
    }
    const compressionMethod = buffer.readUInt16LE(pos + 10)
    const entryCrc = buffer.readUInt32LE(pos + 16)
    let compressedSize = buffer.readUInt32LE(pos + 20)
    let uncompressedSize = buffer.readUInt32LE(pos + 24)
    const nameLen = buffer.readUInt16LE(pos + 28)
    const extraLen = buffer.readUInt16LE(pos + 30)
    const commentLen = buffer.readUInt16LE(pos + 32)
    const externalAttr = buffer.readUInt32LE(pos + 38)
    let localHeaderOffset = buffer.readUInt32LE(pos + 42)

    const recordEnd = pos + 46 + nameLen + extraLen + commentLen
    if (recordEnd > buffer.length) {
      throw new Error('Portable update archive central directory record is truncated')
    }
    const rawName = buffer.toString('utf8', pos + 46, pos + 46 + nameLen)
    const extra = buffer.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen)
    pos = recordEnd

    const unixMode = (externalAttr >>> 16) & UNIX_FILE_TYPE_MASK
    if (unixMode === UNIX_SYMLINK_MODE) {
      throw new Error(`Portable update archive contains a symbolic link: ${rawName}`)
    }

    const zip64 = readZip64Extra(
      extra,
      uncompressedSize === 0xffffffff,
      compressedSize === 0xffffffff,
      localHeaderOffset === 0xffffffff
    )
    uncompressedSize = zip64.uncompressedSize ?? uncompressedSize
    compressedSize = zip64.compressedSize ?? compressedSize
    localHeaderOffset = zip64.localHeaderOffset ?? localHeaderOffset

    const isDirectory = rawName.endsWith('/')
    const relativePath = validateAndStripRoot(rawName, isDirectory, rootDir)
    const dedupeKey = relativePath.toLowerCase()
    if (seenLower.has(dedupeKey)) {
      throw new Error(`Portable update archive contains duplicate entry: ${rawName}`)
    }
    seenLower.add(dedupeKey)

    if (!isDirectory && compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${rawName}`)
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > maxPayloadBytes) {
      throw new Error('Portable update archive exceeds maximum uncompressed size')
    }

    entries.push({
      relativePath,
      isDirectory,
      compressionMethod,
      crc32: entryCrc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    })
  }

  if (entries.length !== cdInfo.entryCount) {
    throw new Error('Portable update archive central directory entry count mismatch')
  }
  return entries
}
