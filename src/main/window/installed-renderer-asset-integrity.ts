import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

type AsarEntry = {
  unpacked?: unknown
  integrity?: { algorithm?: unknown; hash?: unknown }
  files?: Record<string, AsarEntry>
}

type ArchiveFileHandle = {
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ bytesRead: number }>
  close: () => Promise<void>
}

type OpenArchive = (archivePath: string) => Promise<ArchiveFileHandle>

export type InstalledRendererAssetCheck =
  | { status: 'unavailable' }
  | { status: 'intact' }
  | { status: 'modified'; files: string[] }

const RENDERER_DIR = ['out', 'renderer']
// A corrupt header must not make the reader allocate the archive.
const MAX_HEADER_BYTES = 64 * 1024 * 1024

type ArchiveOpener = { open: (archivePath: string, flags: 'r') => Promise<ArchiveFileHandle> }

function isArchiveOpener(value: unknown): value is ArchiveOpener {
  return (
    typeof value === 'object' &&
    value !== null &&
    'open' in value &&
    typeof value.open === 'function'
  )
}

function resolveOpenArchive(): OpenArchive {
  // Electron's patched fs treats app.asar as a directory; original-fs reads the archive bytes.
  const originalFs: unknown = createRequire(__filename)('original-fs')
  const promises =
    typeof originalFs === 'object' && originalFs !== null && 'promises' in originalFs
      ? originalFs.promises
      : undefined
  if (!isArchiveOpener(promises)) {
    throw new Error('original-fs is unavailable')
  }
  return (archivePath) => promises.open(archivePath, 'r')
}

async function readExactly(
  handle: ArchiveFileHandle,
  length: number,
  position: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) {
    throw new Error('Truncated asar header')
  }
  return buffer
}

/** Reads the asar's own index, which Electron's integrity fuse already verifies on macOS and Windows. */
export async function readAsarHeader(
  archivePath: string,
  openArchive: OpenArchive = resolveOpenArchive()
): Promise<AsarEntry> {
  const handle = await openArchive(archivePath)
  try {
    // Pickle layout: [u32 payload size][u32 header size], then [u32 payload size][u32 json length][json].
    const headerSize = (await readExactly(handle, 8, 0)).readUInt32LE(4)
    if (headerSize < 8 || headerSize > MAX_HEADER_BYTES) {
      throw new Error('Invalid asar header size')
    }
    const header = await readExactly(handle, headerSize, 8)
    const jsonLength = header.readUInt32LE(4)
    if (jsonLength > headerSize - 8) {
      throw new Error('Invalid asar header length')
    }
    const parsed: unknown = JSON.parse(header.toString('utf8', 8, 8 + jsonLength))
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid asar header')
    }
    return parsed
  } finally {
    await handle.close()
  }
}

function collectUnpackedHashes(
  entry: AsarEntry,
  relativePath: string[],
  into: { relativePath: string[]; sha256: string }[]
): void {
  if (entry.files) {
    for (const [name, child] of Object.entries(entry.files)) {
      collectUnpackedHashes(child, [...relativePath, name], into)
    }
    return
  }
  const { integrity } = entry
  if (
    entry.unpacked === true &&
    integrity?.algorithm === 'SHA256' &&
    typeof integrity.hash === 'string'
  ) {
    into.push({ relativePath, sha256: integrity.hash })
  }
}

async function sha256OfFile(filePath: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex')
  } catch {
    return null
  }
}

/** Compares unpacked renderer files with the hashes recorded at build time, so edits made after install are named. */
export async function checkInstalledRendererAssets(
  archivePath: string,
  openArchive?: OpenArchive
): Promise<InstalledRendererAssetCheck> {
  let header: AsarEntry
  try {
    header = await readAsarHeader(archivePath, openArchive)
  } catch {
    return { status: 'unavailable' }
  }
  let rendererEntry: AsarEntry | undefined = header
  for (const segment of RENDERER_DIR) {
    rendererEntry = rendererEntry?.files?.[segment]
  }
  if (!rendererEntry) {
    return { status: 'unavailable' }
  }
  const expected: { relativePath: string[]; sha256: string }[] = []
  collectUnpackedHashes(rendererEntry, RENDERER_DIR, expected)
  if (expected.length === 0) {
    return { status: 'unavailable' }
  }
  const unpackedRoot = `${archivePath}.unpacked`
  const modified: string[] = []
  // Sequential reads keep peak memory at one chunk; this runs only after a chunk failed to load.
  for (const asset of expected) {
    const actual = await sha256OfFile(path.join(unpackedRoot, ...asset.relativePath))
    if (actual !== asset.sha256) {
      modified.push(asset.relativePath.slice(RENDERER_DIR.length).join('/'))
    }
  }
  return modified.length > 0 ? { status: 'modified', files: modified } : { status: 'intact' }
}
