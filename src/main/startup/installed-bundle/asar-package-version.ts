import { open, type FileHandle } from 'node:fs/promises'

// Pickle header: uint32 payload size, uint32 header pickle size, uint32 string pickle size, uint32 JSON length.
const PICKLE_PREAMBLE_BYTES = 16
const HEADER_PICKLE_OFFSET = 8
// Guards against reading a non-asar file as a multi-gigabyte header.
const MAX_HEADER_BYTES = 64 * 1024 * 1024

type AsarPackageEntry = { offset: string; size: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function packageJsonEntry(header: unknown): AsarPackageEntry | null {
  if (!isRecord(header) || !isRecord(header.files)) {
    return null
  }
  const entry = header.files['package.json']
  if (!isRecord(entry) || typeof entry.offset !== 'string' || typeof entry.size !== 'number') {
    return null
  }
  return { offset: entry.offset, size: entry.size }
}

async function readExact(
  file: FileHandle,
  length: number,
  position: number
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await file.read(buffer, read, length - read, position + read)
    if (bytesRead === 0) {
      return null
    }
    read += bytesRead
  }
  return buffer
}

/**
 * Reads `package.json`'s version straight from an asar archive's current bytes. Electron's own
 * asar reads go through the header it parsed at launch, so after a package manager replaces the
 * archive they return the previous build's view (or garbage at stale offsets).
 */
export async function readAsarPackageVersion(asarPath: string): Promise<string | null> {
  let file: FileHandle
  try {
    file = await open(asarPath, 'r')
  } catch {
    return null
  }
  try {
    const preamble = await readExact(file, PICKLE_PREAMBLE_BYTES, 0)
    if (!preamble) {
      return null
    }
    const headerPickleSize = preamble.readUInt32LE(4)
    const jsonLength = preamble.readUInt32LE(12)
    if (jsonLength === 0 || jsonLength > MAX_HEADER_BYTES || jsonLength + 8 > headerPickleSize) {
      return null
    }
    const headerJson = await readExact(file, jsonLength, PICKLE_PREAMBLE_BYTES)
    if (!headerJson) {
      return null
    }
    const entry = packageJsonEntry(JSON.parse(headerJson.toString('utf8')))
    if (!entry) {
      return null
    }
    const filesOffset = HEADER_PICKLE_OFFSET + headerPickleSize
    const packageJson = await readExact(file, entry.size, filesOffset + Number(entry.offset))
    if (!packageJson) {
      return null
    }
    const manifest: unknown = JSON.parse(packageJson.toString('utf8'))
    return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  } finally {
    await file.close()
  }
}
