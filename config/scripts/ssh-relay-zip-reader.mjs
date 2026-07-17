import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'

import yauzl from 'yauzl'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function openZip(path) {
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
      (error, zip) => (error ? reject(error) : resolve(zip))
    )
  })
}

function nextEntry(zip) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', onEntry)
      zip.off('end', onEnd)
      zip.off('error', onError)
    }
    const onEntry = (entry) => {
      cleanup()
      resolve(entry)
    }
    const onEnd = () => {
      cleanup()
      resolve(null)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    zip.once('entry', onEntry)
    zip.once('end', onEnd)
    zip.once('error', onError)
    zip.readEntry()
  })
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)))
  })
}

function decodeEntryName(entry) {
  if (!Buffer.isBuffer(entry.fileName)) {
    throw new Error('ZIP reader did not return raw entry-name bytes')
  }
  try {
    return UTF8_DECODER.decode(entry.fileName)
  } catch {
    throw new Error('ZIP entry name must be valid UTF-8')
  }
}

function portableEntryPath(name, limits) {
  if (
    name.length === 0 ||
    Buffer.byteLength(name) > limits.maximumPathBytes ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error('ZIP entry path is not a bounded portable relative path')
  }
  for (const character of name) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f || character === '\\') {
      throw new Error('ZIP entry path contains a control character or backslash')
    }
  }
  const path = name.endsWith('/') ? name.slice(0, -1) : name
  const segments = path.split('/')
  if (
    segments.length > limits.maximumDepth ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_DEVICE_NAME.test(segment)
    )
  ) {
    throw new Error('ZIP entry path contains an unsafe path segment')
  }
  return path
}

function entryInfo(entry, path) {
  const hostSystem = entry.versionMadeBy >>> 8
  const unixMode = hostSystem === 3 ? (entry.externalFileAttributes >>> 16) & 0xffff : null
  if (unixMode !== null && (unixMode & 0o170000) === 0o120000) {
    throw new Error(`ZIP archive contains a prohibited symbolic link: ${path}`)
  }
  if ((entry.generalPurposeBitFlag & ENCRYPTION_FLAGS) !== 0) {
    throw new Error(`ZIP archive contains an encrypted entry: ${path}`)
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`ZIP archive uses an unsupported compression method: ${path}`)
  }
  const directory = entry.fileName.at(-1) === 0x2f
  if (directory && (entry.uncompressedSize !== 0 || entry.compressedSize !== 0)) {
    throw new Error(`ZIP directory entry contains file data: ${path}`)
  }
  return {
    path,
    type: directory ? 'directory' : 'file',
    compressedSize: entry.compressedSize,
    size: entry.uncompressedSize,
    crc32: entry.crc32 >>> 0,
    hostSystem,
    unixMode,
    compressionMethod: entry.compressionMethod
  }
}

async function consumeEntry(zip, entry, info, { outputPath, mode, signal } = {}) {
  const input = await openEntryStream(zip, entry)
  let bytes = 0
  let checksum = 0
  const digest = createHash('sha256')
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > info.size) {
        callback(new Error(`ZIP entry expanded beyond its declared size: ${info.path}`))
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
    throw new Error(`ZIP entry size or CRC-32 mismatch: ${info.path}`)
  }
  return { bytes, sha256: `sha256:${digest.digest('hex')}` }
}

export async function visitSshRelayZip(archivePath, limits, visitor, { signal } = {}) {
  const metadata = await stat(archivePath)
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > limits.maximumArchiveBytes) {
    throw new Error('ZIP archive exceeds its compressed-size limit')
  }
  const zip = await openZip(archivePath)
  const foldedPaths = new Set()
  let entries = 0
  let files = 0
  let expandedBytes = 0
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      signal?.throwIfAborted()
      const path = portableEntryPath(decodeEntryName(entry), limits)
      const folded = path.toLowerCase()
      if (foldedPaths.has(folded)) {
        throw new Error(`ZIP archive contains a duplicate or case-fold collision: ${path}`)
      }
      foldedPaths.add(folded)
      const info = entryInfo(entry, path)
      entries += 1
      if (entries > limits.maximumEntries) {
        throw new Error('ZIP archive exceeds the entry-count limit')
      }
      if (info.type === 'file') {
        files += 1
        if (!Number.isSafeInteger(info.size) || info.size > limits.maximumFileBytes) {
          throw new Error(`ZIP archive file exceeds the per-file size limit: ${path}`)
        }
        expandedBytes += info.size
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maximumExpandedBytes) {
          throw new Error('ZIP archive exceeds the expanded-size limit')
        }
      }
      let consumed = info.type === 'directory'
      const consume = async (options) => {
        if (consumed) {
          throw new Error(`ZIP entry was consumed more than once: ${path}`)
        }
        consumed = true
        return consumeEntry(zip, entry, info, { ...options, signal: options?.signal ?? signal })
      }
      await visitor(info, consume)
      if (!consumed) {
        throw new Error(`ZIP visitor did not verify file bytes: ${path}`)
      }
    }
    return { entries, files, expandedBytes }
  } finally {
    zip.close()
  }
}
