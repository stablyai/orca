import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  readJsonlFileSnapshot,
  readJsonlHandleSnapshot,
  readJsonlSnapshotRange,
  releaseJsonlReadStream,
  sameJsonlFileSnapshot,
  verifyJsonlSnapshotContents,
  type JsonlFileSnapshot
} from './jsonl-file-snapshot'

const CHECKPOINT_WINDOW_BYTES = 4096

// Below this measured crossover, verifying the prefix costs more than rereading it.
export const MIN_RESUMABLE_PREFIX_BYTES = 3 * CHECKPOINT_WINDOW_BYTES

export type JsonlFileCheckpoint = {
  parsedBytes: number
  boundaryDigest: string
  headDigest: string
  physicalFileId: string | null
}

export type JsonlFileReader = {
  path: string
  handle: FileHandle
  stats: JsonlFileSnapshot
  snapshotCheckpoint: JsonlFileCheckpoint | null
  snapshotChunks: Buffer[] | null
  snapshotBytes: number
  streamStartOffset: number
  streamBytes: number
  onChunk: (chunk: Buffer) => void
  prepareRead: (startOffset: number) => Promise<void>
}

export function isResumablePrefixLength(parsedBytes: number): boolean {
  return parsedBytes > MIN_RESUMABLE_PREFIX_BYTES
}

async function readWindowDigest(
  filePath: string,
  start: number,
  endExclusive: number,
  reader?: JsonlFileReader
): Promise<string | null> {
  const expectedBytes = endExclusive - start
  const hash = createHash('sha256')
  let readBytes = 0
  if (expectedBytes === 0) {
    return `0:${hash.digest('hex')}`
  }
  if (reader) {
    const buffer = await readJsonlSnapshotRange(
      filePath,
      reader.handle,
      reader.stats,
      start,
      endExclusive
    )
    if (!buffer) {
      return null
    }
    hash.update(buffer)
    return `${buffer.length}:${hash.digest('hex')}`
  }
  const range = { start, end: endExclusive - 1 }
  const stream = createReadStream(filePath, range)
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(buffer)
      readBytes += buffer.length
    }
  } finally {
    await releaseJsonlReadStream(stream)
  }
  return readBytes === expectedBytes ? `${expectedBytes}:${hash.digest('hex')}` : null
}

async function readPrefixDigests(
  filePath: string,
  parsedBytes: number,
  carriedHeadDigest: string | null = null,
  reader?: JsonlFileReader
): Promise<{ headDigest: string; boundaryDigest: string } | null> {
  const headBytes = Math.min(CHECKPOINT_WINDOW_BYTES, parsedBytes)
  const headDigest = carriedHeadDigest?.startsWith(`${headBytes}:`)
    ? carriedHeadDigest
    : await readWindowDigest(filePath, 0, headBytes, reader)
  if (headDigest === null) {
    return null
  }
  const boundaryDigest = await readWindowDigest(
    filePath,
    Math.max(0, parsedBytes - CHECKPOINT_WINDOW_BYTES),
    parsedBytes,
    reader
  )
  return boundaryDigest === null ? null : { headDigest, boundaryDigest }
}

export function jsonlPhysicalFileId(stats: {
  dev: number | bigint
  ino: number | bigint
}): string | null {
  return stats.ino === 0 || stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`
}

export async function openJsonlFileReader(filePath: string): Promise<JsonlFileReader> {
  while (true) {
    const handle = await open(filePath, 'r')
    let retained = false
    try {
      const stats = await readJsonlHandleSnapshot(handle)
      const reader: JsonlFileReader = {
        path: filePath,
        handle,
        stats,
        snapshotCheckpoint: null,
        snapshotChunks: isResumablePrefixLength(stats.size) ? null : [],
        snapshotBytes: 0,
        streamStartOffset: 0,
        streamBytes: 0,
        onChunk: (chunk) => {
          reader.streamBytes += chunk.length
          if (reader.snapshotChunks) {
            reader.snapshotChunks.push(chunk)
            reader.snapshotBytes += chunk.length
          }
        },
        prepareRead: async (startOffset) => {
          reader.streamStartOffset = Math.min(startOffset, stats.size)
          if (!reader.snapshotChunks || reader.snapshotBytes !== 0 || startOffset <= 0) {
            return
          }
          const skipped = await readJsonlSnapshotRange(
            filePath,
            handle,
            stats,
            0,
            Math.min(startOffset, stats.size)
          )
          if (!skipped) {
            return
          }
          reader.snapshotChunks.push(skipped)
          reader.snapshotBytes += skipped.length
        }
      }
      if (!isResumablePrefixLength(stats.size)) {
        retained = true
        return reader
      }
      const digests = await readPrefixDigests(filePath, stats.size, null, reader)
      if (!digests) {
        continue
      }
      reader.snapshotCheckpoint = {
        parsedBytes: stats.size,
        ...digests,
        physicalFileId: jsonlPhysicalFileId(stats)
      }
      retained = true
      return reader
    } finally {
      if (!retained) {
        await handle.close()
      }
    }
  }
}

async function readPhysicalFileId(filePath: string): Promise<string | null> {
  try {
    const fileStat = await readJsonlFileSnapshot(filePath)
    return jsonlPhysicalFileId(fileStat)
  } catch {
    return null
  }
}

export async function buildJsonlFileCheckpoint(
  filePath: string,
  parsedBytes: number,
  verifiedHeadDigest: string | null = null,
  reader?: JsonlFileReader
): Promise<JsonlFileCheckpoint | null> {
  if (!isResumablePrefixLength(parsedBytes)) {
    return null
  }
  if (reader?.snapshotCheckpoint?.parsedBytes === parsedBytes) {
    return reader.snapshotCheckpoint
  }
  const digests = await readPrefixDigests(
    filePath,
    parsedBytes,
    verifiedHeadDigest ?? reader?.snapshotCheckpoint?.headDigest,
    reader
  )
  return digests === null
    ? null
    : {
        parsedBytes,
        ...digests,
        physicalFileId: reader
          ? jsonlPhysicalFileId(reader.stats)
          : await readPhysicalFileId(filePath)
      }
}

// Append-only evidence catches rotation, truncation and head/tail rewrites; it cannot prove the middle.
export async function resolveJsonlFileCheckpoint(
  filePath: string,
  checkpoint: JsonlFileCheckpoint | null | undefined,
  reader?: JsonlFileReader
): Promise<JsonlFileCheckpoint | null> {
  if (
    !checkpoint ||
    !Number.isSafeInteger(checkpoint.parsedBytes) ||
    !isResumablePrefixLength(checkpoint.parsedBytes) ||
    (reader && checkpoint.parsedBytes > reader.stats.size) ||
    typeof checkpoint.boundaryDigest !== 'string' ||
    typeof checkpoint.headDigest !== 'string'
  ) {
    return null
  }
  const currentFileId = reader
    ? jsonlPhysicalFileId(reader.stats)
    : await readPhysicalFileId(filePath)
  if (
    checkpoint.physicalFileId !== null &&
    currentFileId !== null &&
    checkpoint.physicalFileId !== currentFileId
  ) {
    return null
  }
  const digests = await readPrefixDigests(
    filePath,
    checkpoint.parsedBytes,
    reader?.snapshotCheckpoint?.headDigest,
    reader
  )
  return digests?.boundaryDigest === checkpoint.boundaryDigest &&
    digests?.headDigest === checkpoint.headDigest
    ? checkpoint
    : null
}

export async function validateJsonlFileReader(
  reader: JsonlFileReader,
  originalCheckpoint?: JsonlFileCheckpoint | null
): Promise<boolean> {
  const [current, pathStats] = await Promise.all([
    readJsonlHandleSnapshot(reader.handle),
    readJsonlFileSnapshot(reader.path)
  ])
  if (reader.streamBytes !== reader.stats.size - reader.streamStartOffset) {
    if (
      sameJsonlFileSnapshot(reader.stats, current) &&
      sameJsonlFileSnapshot(reader.stats, pathStats)
    ) {
      throw new Error('JSONL snapshot stream ended before the unchanged file boundary.')
    }
    return false
  }
  if (
    current.dev !== reader.stats.dev ||
    current.ino !== reader.stats.ino ||
    pathStats.dev !== current.dev ||
    pathStats.ino !== current.ino ||
    current.size < reader.stats.size ||
    (current.size === reader.stats.size &&
      (current.mtimeMs !== reader.stats.mtimeMs || current.ctimeMs !== reader.stats.ctimeMs))
  ) {
    return false
  }
  const snapshot = reader.snapshotCheckpoint
  if (!snapshot) {
    if (!reader.snapshotChunks || reader.snapshotBytes !== reader.stats.size) {
      return false
    }
    const chunks = reader.snapshotChunks
    reader.snapshotChunks = null
    return verifyJsonlSnapshotContents(reader.path, reader.handle, reader.stats, chunks)
  }
  const snapshotDigests = await readPrefixDigests(reader.path, snapshot.parsedBytes, null, reader)
  if (
    snapshotDigests?.headDigest !== snapshot.headDigest ||
    snapshotDigests?.boundaryDigest !== snapshot.boundaryDigest
  ) {
    return false
  }
  if (!originalCheckpoint || originalCheckpoint.parsedBytes === snapshot.parsedBytes) {
    return true
  }
  const originalBoundary = await readWindowDigest(
    reader.path,
    Math.max(0, originalCheckpoint.parsedBytes - CHECKPOINT_WINDOW_BYTES),
    originalCheckpoint.parsedBytes,
    reader
  )
  return (
    originalCheckpoint.headDigest === snapshotDigests.headDigest &&
    originalCheckpoint.boundaryDigest === originalBoundary
  )
}
