import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { SKILL_PACKAGE_MAX_COMPRESSED_BYTES } from '../../shared/skill-package-manifest'
import { createDeterministicGzipStore } from './skill-package-deterministic-gzip'
import { buildUstarEntryHeader, USTAR_BLOCK_BYTES, ustarPaddingBytes } from '../ustar-entry-header'

const TAR_BLOCK_BYTES = USTAR_BLOCK_BYTES
const TAR_EXPANDED_LIMIT = 40 * 1024 * 1024

export type SkillTarWriteEntry = {
  path: string
  size: number
  executable: boolean
  sourcePath?: string
  bytes?: Buffer
}

export type SkillTarReadEntry = {
  path: string
  size: number
  executable: boolean
}

function tarHeader(entry: SkillTarWriteEntry): Buffer {
  return buildUstarEntryHeader(
    { path: entry.path, size: entry.size, mode: entry.executable ? 0o755 : 0o644, type: 'file' },
    'skill-package'
  )
}

async function writeWithBackpressure(stream: Writable, bytes: Buffer): Promise<void> {
  if (!stream.write(bytes)) {
    await once(stream, 'drain')
  }
}

export async function writeSkillTarGzip(
  archivePath: string,
  entries: readonly SkillTarWriteEntry[]
): Promise<{ archiveSha256: string; compressedBytes: number }> {
  const archiveHash = createHash('sha256')
  let compressedBytes = 0
  const gzip = createDeterministicGzipStore()
  const hashTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length
      if (compressedBytes > SKILL_PACKAGE_MAX_COMPRESSED_BYTES) {
        callback(new Error('skill-package-compressed-size-limit'))
        return
      }
      archiveHash.update(chunk)
      callback(null, chunk)
    }
  })
  const sink = pipeline(
    gzip,
    hashTransform,
    createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
  )
  try {
    for (const entry of entries) {
      await writeWithBackpressure(gzip, tarHeader(entry))
      if (entry.bytes) {
        if (entry.bytes.length !== entry.size) {
          throw new Error('skill-package-source-size-mismatch')
        }
        await writeWithBackpressure(gzip, entry.bytes)
      } else if (entry.sourcePath) {
        let written = 0
        for await (const chunk of createReadStream(entry.sourcePath)) {
          written += chunk.length
          if (written > entry.size) {
            throw new Error('skill-package-source-size-mismatch')
          }
          await writeWithBackpressure(gzip, chunk)
        }
        if (written !== entry.size) {
          throw new Error('skill-package-source-size-mismatch')
        }
      } else {
        throw new Error('skill-package-source-required')
      }
      const padding = ustarPaddingBytes(entry.size)
      if (padding > 0) {
        await writeWithBackpressure(gzip, Buffer.alloc(padding))
      }
    }
    await writeWithBackpressure(gzip, Buffer.alloc(TAR_BLOCK_BYTES * 2))
    gzip.end()
    await sink
    return { archiveSha256: archiveHash.digest('hex'), compressedBytes }
  } catch (error) {
    gzip.destroy(error instanceof Error ? error : new Error(String(error)))
    await sink.catch(() => undefined)
    throw error
  }
}

export class TarByteReader {
  private readonly iterator: AsyncIterator<Buffer>
  private current: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private currentOffset = 0
  private consumed = 0

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  }

  async readExact(length: number): Promise<Buffer> {
    const bytes = await this.readExactOrNull(length)
    if (!bytes) {
      throw new Error('skill-package-tar-truncated')
    }
    return bytes
  }

  async readExactOrNull(length: number): Promise<Buffer | null> {
    const result = Buffer.alloc(length)
    let written = 0
    while (written < length) {
      if (this.currentOffset >= this.current.length) {
        const next = await this.iterator.next()
        if (next.done) {
          if (written === 0) {
            return null
          }
          throw new Error('skill-package-tar-truncated')
        }
        this.current = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value)
        this.currentOffset = 0
      }
      const available = Math.min(length - written, this.current.length - this.currentOffset)
      this.current.copy(result, written, this.currentOffset, this.currentOffset + available)
      this.currentOffset += available
      written += available
      this.consumed += available
      if (this.consumed > TAR_EXPANDED_LIMIT) {
        throw new Error('skill-package-expanded-size-limit')
      }
    }
    return result
  }
}

function readString(header: Buffer, offset: number, length: number): string {
  const end = header.indexOf(0, offset)
  return header
    .subarray(offset, end === -1 || end > offset + length ? offset + length : end)
    .toString('utf8')
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const value = readString(header, offset, length).trim()
  if (!/^[0-7]+$/.test(value)) {
    throw new Error('skill-package-tar-number-invalid')
  }
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('skill-package-tar-number-invalid')
  }
  return parsed
}

function validateTarChecksum(header: Buffer): void {
  const expected = readOctal(header, 148, 8)
  const copy = Buffer.from(header)
  copy.fill(0x20, 148, 156)
  if (copy.reduce((sum, byte) => sum + byte, 0) !== expected) {
    throw new Error('skill-package-tar-checksum-invalid')
  }
}

export function parseSkillTarHeader(header: Buffer): SkillTarReadEntry | null {
  if (header.length !== TAR_BLOCK_BYTES) {
    throw new Error('skill-package-tar-truncated')
  }
  if (header.every((byte) => byte === 0)) {
    return null
  }
  validateTarChecksum(header)
  if (readString(header, 257, 6) !== 'ustar' || readString(header, 263, 2) !== '00') {
    throw new Error('skill-package-tar-format-invalid')
  }
  const type = header[156]
  if (type !== 0 && type !== '0'.charCodeAt(0)) {
    throw new Error('skill-package-tar-entry-type')
  }
  const name = readString(header, 0, 100)
  const prefix = readString(header, 345, 155)
  const path = prefix ? `${prefix}/${name}` : name
  if (!path) {
    throw new Error('skill-package-tar-path-invalid')
  }
  const mode = readOctal(header, 100, 8)
  return { path, size: readOctal(header, 124, 12), executable: (mode & 0o111) !== 0 }
}

export async function openSkillTarGzip(archivePath: string): Promise<{
  reader: TarByteReader
  archiveIdentity: Promise<{ archiveSha256: string; compressedBytes: number }>
  abort: (error: Error) => void
}> {
  const archiveHash = createHash('sha256')
  let compressedBytes = 0
  const source = createReadStream(archivePath)
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length
      if (compressedBytes > SKILL_PACKAGE_MAX_COMPRESSED_BYTES) {
        callback(new Error('skill-package-compressed-size-limit'))
        return
      }
      archiveHash.update(chunk)
      callback(null, chunk)
    }
  })
  const gunzip = createGunzip()
  // Observe late aborts before the archive reader starts.
  gunzip.on('error', () => undefined)
  const completion = pipeline(source, verifier, gunzip)
  const archiveIdentity = completion.then(() => ({
    archiveSha256: archiveHash.digest('hex'),
    compressedBytes
  }))
  return {
    reader: new TarByteReader(gunzip),
    archiveIdentity,
    abort: (error) => {
      source.destroy(error)
      verifier.destroy(error)
      gunzip.destroy(error)
    }
  }
}

export const SKILL_TAR_BLOCK_BYTES = TAR_BLOCK_BYTES
