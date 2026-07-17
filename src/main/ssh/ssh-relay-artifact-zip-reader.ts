import { createHash } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { type Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'

type ZipEntry = {
  fileName: Buffer
  versionMadeBy: number
  externalFileAttributes: number
  generalPurposeBitFlag: number
  compressionMethod: number
  uncompressedSize: number
  compressedSize: number
  crc32: number
}

type ZipFile = EventEmitter & {
  readEntry(): void
  close(): void
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream?: Readable) => void): void
}

type YauzlModule = {
  open(
    path: string,
    options: {
      autoClose: boolean
      lazyEntries: boolean
      decodeStrings: boolean
      strictFileNames: boolean
      validateEntrySizes: boolean
    },
    callback: (error: Error | null, zip?: ZipFile) => void
  ): void
}

export type SshRelayZipLimits = {
  maximumArchiveBytes: number
  maximumEntries: number
  maximumExpandedBytes: number
  maximumFileBytes: number
  maximumDepth: number
  maximumPathBytes: number
}

export type SshRelayZipEntryInfo = {
  path: string
  type: 'directory' | 'file'
  size: number
  crc32: number
  unixMode: number | null
}

const yauzl = createRequire(import.meta.url)('yauzl') as YauzlModule
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: false,
        strictFileNames: true,
        validateEntrySizes: true
      },
      (error, zip) =>
        error ? reject(error) : zip ? resolve(zip) : reject(new Error('ZIP missing'))
    )
  })
}

function nextEntry(zip: ZipFile): Promise<ZipEntry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      zip.off('entry', onEntry)
      zip.off('end', onEnd)
      zip.off('error', onError)
    }
    const onEntry = (entry: ZipEntry): void => {
      cleanup()
      resolve(entry)
    }
    const onEnd = (): void => {
      cleanup()
      resolve(null)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    zip.once('entry', onEntry)
    zip.once('end', onEnd)
    zip.once('error', onError)
    zip.readEntry()
  })
}

function openEntryStream(zip: ZipFile, entry: ZipEntry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) =>
      error ? reject(error) : stream ? resolve(stream) : reject(new Error('ZIP stream missing'))
    )
  })
}

function decodeEntryName(entry: ZipEntry): string {
  try {
    return UTF8_DECODER.decode(entry.fileName)
  } catch {
    throw new Error('SSH relay ZIP entry name must be valid UTF-8')
  }
}

function portableEntryPath(name: string, limits: SshRelayZipLimits): string {
  if (
    !name ||
    Buffer.byteLength(name) > limits.maximumPathBytes ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error('SSH relay ZIP entry path is not a bounded portable relative path')
  }
  for (const character of name) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f || character === '\\') {
      throw new Error('SSH relay ZIP entry path contains a control character or backslash')
    }
  }
  const path = name.endsWith('/') ? name.slice(0, -1) : name
  const segments = path.split('/')
  if (
    segments.length > limits.maximumDepth ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_DEVICE_NAME.test(segment)
    )
  ) {
    throw new Error('SSH relay ZIP entry path contains an unsafe path segment')
  }
  return path
}

function entryInfo(entry: ZipEntry, path: string): SshRelayZipEntryInfo {
  const hostSystem = entry.versionMadeBy >>> 8
  const unixMode = hostSystem === 3 ? (entry.externalFileAttributes >>> 16) & 0xffff : null
  if (unixMode !== null && (unixMode & 0o170000) === 0o120000) {
    throw new Error(`SSH relay ZIP contains a prohibited symbolic link: ${path}`)
  }
  if ((entry.generalPurposeBitFlag & ENCRYPTION_FLAGS) !== 0) {
    throw new Error(`SSH relay ZIP contains an encrypted entry: ${path}`)
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`SSH relay ZIP uses an unsupported compression method: ${path}`)
  }
  const directory = entry.fileName.at(-1) === 0x2f
  if (directory && (entry.uncompressedSize !== 0 || entry.compressedSize !== 0)) {
    throw new Error(`SSH relay ZIP directory contains file data: ${path}`)
  }
  return {
    path,
    type: directory ? 'directory' : 'file',
    size: entry.uncompressedSize,
    crc32: entry.crc32 >>> 0,
    unixMode
  }
}

async function consumeEntry({
  zip,
  entry,
  info,
  outputPath,
  mode,
  signal
}: {
  zip: ZipFile
  entry: ZipEntry
  info: SshRelayZipEntryInfo
  outputPath?: string
  mode?: number
  signal: AbortSignal
}): Promise<string> {
  const input = await openEntryStream(zip, entry)
  let bytes = 0
  let checksum = 0
  const digest = createHash('sha256')
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > info.size) {
        callback(new Error(`SSH relay ZIP entry expanded beyond its signed size: ${info.path}`))
        return
      }
      checksum = crc32(chunk, checksum)
      digest.update(chunk)
      callback(null, chunk)
    }
  })
  const sink = outputPath
    ? (await mkdir(dirname(outputPath), { recursive: true }),
      createWriteStream(outputPath, { flags: 'wx', mode: mode ?? 0o600 }))
    : new Writable({ write: (_chunk, _encoding, callback) => callback() })
  await pipeline(input, verifier, sink, { signal })
  if (bytes !== info.size || checksum >>> 0 !== info.crc32) {
    throw new Error(`SSH relay ZIP entry size or CRC-32 mismatch: ${info.path}`)
  }
  return `sha256:${digest.digest('hex')}`
}

export async function visitSshRelayZip(
  archivePath: string,
  limits: SshRelayZipLimits,
  visitor: (
    actual: SshRelayZipEntryInfo,
    consume: (options?: { outputPath?: string; mode?: number }) => Promise<string>
  ) => Promise<void>,
  signal: AbortSignal
): Promise<{ files: number; expandedBytes: number }> {
  const metadata = await stat(archivePath)
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > limits.maximumArchiveBytes) {
    throw new Error('SSH relay ZIP exceeds its compressed-size limit')
  }
  const zip = await openZip(archivePath)
  const foldedPaths = new Set<string>()
  let entries = 0
  let files = 0
  let expandedBytes = 0
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      signal.throwIfAborted()
      const path = portableEntryPath(decodeEntryName(entry), limits)
      const folded = path.toLowerCase()
      if (foldedPaths.has(folded)) {
        throw new Error(`SSH relay ZIP has a duplicate or case-fold collision: ${path}`)
      }
      foldedPaths.add(folded)
      const info = entryInfo(entry, path)
      entries += 1
      if (entries > limits.maximumEntries) {
        throw new Error('SSH relay ZIP exceeds the entry-count limit')
      }
      if (info.type === 'file') {
        files += 1
        if (!Number.isSafeInteger(info.size) || info.size > limits.maximumFileBytes) {
          throw new Error(`SSH relay ZIP file exceeds the per-file size limit: ${path}`)
        }
        expandedBytes += info.size
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maximumExpandedBytes) {
          throw new Error('SSH relay ZIP exceeds the expanded-size limit')
        }
      }
      let consumed = info.type === 'directory'
      const consume = async (options?: { outputPath?: string; mode?: number }): Promise<string> => {
        if (consumed) {
          throw new Error(`SSH relay ZIP entry was consumed more than once: ${path}`)
        }
        consumed = true
        return consumeEntry({ zip, entry, info, ...options, signal })
      }
      await visitor(info, consume)
      if (!consumed) {
        throw new Error(`SSH relay ZIP visitor did not verify file bytes: ${path}`)
      }
    }
    return { files, expandedBytes }
  } finally {
    zip.close()
  }
}
