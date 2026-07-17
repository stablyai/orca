import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'

type SelectedTuple = SshRelaySelectedArtifact['tuple']
type DeclaredEntry = SelectedTuple['entries'][number]

const TAR_BLOCK_BYTES = 512
const TAR_CHECKSUM_OFFSET = 148
const TAR_CHECKSUM_BYTES = 8
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function allZero(bytes: Uint8Array, start = 0, end = bytes.length): boolean {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) {
      return false
    }
  }
  return true
}

function tarString(header: Buffer, offset: number, length: number, label: string): string {
  const field = header.subarray(offset, offset + length)
  const terminator = field.indexOf(0)
  const content = terminator === -1 ? field : field.subarray(0, terminator)
  if (terminator !== -1 && !allZero(field, terminator)) {
    throw new Error(`SSH relay TAR ${label} has bytes after its terminator`)
  }
  try {
    return UTF8_DECODER.decode(content)
  } catch {
    throw new Error(`SSH relay TAR ${label} must be valid UTF-8`)
  }
}

function tarOctal(header: Buffer, offset: number, length: number, label: string): number {
  const field = header.subarray(offset, offset + length)
  let end = field.indexOf(0)
  if (end === -1) {
    end = field.length
  }
  const value = field.subarray(0, end).toString('ascii').trim()
  if (!/^[0-7]+$/.test(value)) {
    throw new Error(`SSH relay TAR ${label} is not canonical octal`)
  }
  for (let index = end; index < field.length; index += 1) {
    if (field[index] !== 0 && field[index] !== 0x20) {
      throw new Error(`SSH relay TAR ${label} has invalid padding`)
    }
  }
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`SSH relay TAR ${label} exceeds the safe integer range`)
  }
  return parsed
}

function assertHeaderChecksum(header: Buffer): void {
  const expected = tarOctal(header, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_BYTES, 'checksum')
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual +=
      index >= TAR_CHECKSUM_OFFSET && index < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES
        ? 0x20
        : header[index]
  }
  if (actual !== expected) {
    throw new Error('SSH relay TAR header checksum mismatch')
  }
}

function headerPath(header: Buffer): string {
  const name = tarString(header, 0, 100, 'name')
  const prefix = tarString(header, 345, 155, 'prefix')
  if (!name) {
    throw new Error('SSH relay TAR entry name is empty')
  }
  const path = prefix ? `${prefix}/${name}` : name
  return path.endsWith('/') ? path.slice(0, -1) : path
}

function assertHeaderFormat(header: Buffer): void {
  if (
    !header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii')) ||
    !header.subarray(263, 265).equals(Buffer.from('00', 'ascii'))
  ) {
    throw new Error('SSH relay TAR entry is not canonical USTAR')
  }
}

type ParsedHeader = {
  declared: DeclaredEntry
  path: string
  size: number
}

function parseHeader(
  header: Buffer,
  expected: ReadonlyMap<string, DeclaredEntry>,
  seen: Set<string>
): ParsedHeader {
  assertHeaderChecksum(header)
  assertHeaderFormat(header)
  const path = headerPath(header)
  const declared = expected.get(path)
  if (!declared || seen.has(path)) {
    throw new Error(`SSH relay TAR has an extra or duplicate entry: ${path}`)
  }
  seen.add(path)
  const typeFlag = header[156]
  const actualType =
    typeFlag === 0 || typeFlag === 0x30 ? 'file' : typeFlag === 0x35 ? 'directory' : null
  const mode = tarOctal(header, 100, 8, 'mode')
  const size = tarOctal(header, 124, 12, 'size')
  if (actualType !== declared.type || (mode & 0o777) !== declared.mode) {
    throw new Error(`SSH relay TAR type or mode mismatch: ${path}`)
  }
  if (declared.type === 'directory' ? size !== 0 : size !== declared.size) {
    throw new Error(`SSH relay TAR size mismatch: ${path}`)
  }
  return { declared, path, size }
}

function assertZeroPadding(bytes: Buffer, start: number, end: number): void {
  if (!allZero(bytes, start, end)) {
    throw new Error('SSH relay TAR file padding must be zero')
  }
}

function inspectionSink(tuple: SelectedTuple): Writable {
  const expected = new Map(tuple.entries.map((entry) => [entry.path, entry]))
  const expectedTarBytes =
    tuple.entries.reduce(
      (total, entry) =>
        total +
        TAR_BLOCK_BYTES +
        (entry.type === 'file' ? Math.ceil(entry.size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES : 0),
      0
    ) +
    2 * TAR_BLOCK_BYTES
  const seen = new Set<string>()
  const header = Buffer.allocUnsafe(TAR_BLOCK_BYTES)
  let headerBytes = 0
  let remainingFileBytes = 0
  let remainingPaddingBytes = 0
  let fileDigest: Hash | null = null
  let fileEntry: Extract<DeclaredEntry, { type: 'file' }> | null = null
  let filePath = ''
  let endBlocks = 0
  let inspectedBytes = 0

  function finishFile(): void {
    if (!fileDigest || !fileEntry) {
      return
    }
    const actual = `sha256:${fileDigest.digest('hex')}`
    if (actual !== fileEntry.sha256) {
      throw new Error(`SSH relay TAR file integrity mismatch: ${filePath}`)
    }
    fileDigest = null
    fileEntry = null
    filePath = ''
  }

  function acceptHeader(): void {
    if (allZero(header)) {
      endBlocks += 1
      return
    }
    if (endBlocks !== 0) {
      throw new Error('SSH relay TAR end marker is interrupted by another entry')
    }
    const parsed = parseHeader(header, expected, seen)
    remainingFileBytes = parsed.size
    remainingPaddingBytes = (TAR_BLOCK_BYTES - (parsed.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
    if (parsed.declared.type === 'file') {
      fileDigest = createHash('sha256')
      fileEntry = parsed.declared
      filePath = parsed.path
      if (parsed.size === 0) {
        finishFile()
      }
    }
  }

  function consume(chunk: Buffer): void {
    let offset = 0
    while (offset < chunk.length) {
      if (remainingFileBytes > 0) {
        const length = Math.min(remainingFileBytes, chunk.length - offset)
        inspectedBytes += length
        fileDigest?.update(chunk.subarray(offset, offset + length))
        remainingFileBytes -= length
        offset += length
        if (remainingFileBytes === 0) {
          finishFile()
        }
        continue
      }
      if (remainingPaddingBytes > 0) {
        const length = Math.min(remainingPaddingBytes, chunk.length - offset)
        inspectedBytes += length
        assertZeroPadding(chunk, offset, offset + length)
        remainingPaddingBytes -= length
        offset += length
        continue
      }
      const length = Math.min(TAR_BLOCK_BYTES - headerBytes, chunk.length - offset)
      inspectedBytes += length
      if (inspectedBytes > expectedTarBytes) {
        throw new Error('SSH relay TAR exceeds its signed aggregate size')
      }
      chunk.copy(header, headerBytes, offset, offset + length)
      headerBytes += length
      offset += length
      if (headerBytes === TAR_BLOCK_BYTES) {
        headerBytes = 0
        acceptHeader()
      }
    }
  }

  function finish(): void {
    if (
      headerBytes !== 0 ||
      remainingFileBytes !== 0 ||
      remainingPaddingBytes !== 0 ||
      fileDigest ||
      endBlocks !== 2 ||
      inspectedBytes !== expectedTarBytes
    ) {
      throw new Error('SSH relay TAR is truncated or lacks its two-block end marker')
    }
    const missing = tuple.entries.find((entry) => !seen.has(entry.path))
    if (missing) {
      throw new Error(`SSH relay TAR is missing a declared entry: ${missing.path}`)
    }
  }

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        consume(chunk)
        callback()
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
    final(callback) {
      try {
        finish()
        callback()
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    }
  })
}

export async function inspectSshRelayTarBrotli({
  archivePath,
  tuple,
  signal,
  chunkBytes
}: {
  archivePath: string
  tuple: SelectedTuple
  signal: AbortSignal
  chunkBytes: number
}): Promise<void> {
  // Why: a block-state inspector avoids retaining expanded TAR data before the separate write pass.
  await pipeline(
    createReadStream(archivePath, { highWaterMark: chunkBytes }),
    createBrotliDecompress({ chunkSize: chunkBytes }),
    inspectionSink(tuple),
    { signal }
  )
}
