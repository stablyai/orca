import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

export type TarArchiveEntry = {
  readonly name: string
  readonly filePath: string
  readonly mode?: number
}

export type TarArchiveResult = {
  readonly skipped: readonly string[]
}

const BLOCK_SIZE = 512
const MAX_TAR_FILE_SIZE = 0o77777777777

export async function createTarGzipArchive(
  outputPath: string,
  entries: readonly TarArchiveEntry[]
): Promise<TarArchiveResult> {
  const skipped: string[] = []
  const stream = Readable.from(tarBlocks(entries, skipped))
  await pipeline(stream, createGzip(), createWriteStream(outputPath, { mode: 0o600 }))
  return { skipped }
}

async function* tarBlocks(
  entries: readonly TarArchiveEntry[],
  skipped: string[]
): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    const info = await stat(entry.filePath)
    const name = normalizeEntryName(entry.name)
    if (info.size > MAX_TAR_FILE_SIZE || Buffer.byteLength(name) > 100) {
      skipped.push(entry.name)
      continue
    }
    yield createHeader({
      name,
      size: info.size,
      mode: entry.mode ?? 0o600,
      mtime: Math.floor(info.mtimeMs / 1000)
    })
    for await (const chunk of createReadStream(entry.filePath)) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    }
    const remainder = info.size % BLOCK_SIZE
    if (remainder > 0) {
      yield Buffer.alloc(BLOCK_SIZE - remainder)
    }
  }
  yield Buffer.alloc(BLOCK_SIZE * 2)
}

function normalizeEntryName(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
  return normalized || basename(name)
}

function createHeader({
  name,
  size,
  mode,
  mtime
}: {
  readonly name: string
  readonly size: number
  readonly mode: number
  readonly mtime: number
}): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE)
  writeString(header, name, 0, 100)
  writeOctal(header, mode, 100, 8)
  writeOctal(header, 0, 108, 8)
  writeOctal(header, 0, 116, 8)
  writeOctal(header, size, 124, 12)
  writeOctal(header, mtime, 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeString(header, 'ustar', 257, 6)
  writeString(header, '00', 263, 2)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeChecksum(header, checksum)
  return header
}

function writeString(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf8')
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = Math.floor(value)
    .toString(8)
    .padStart(length - 1, '0')
    .slice(-(length - 1))
  header.write(`${encoded}\0`, offset, length, 'ascii')
}

function writeChecksum(header: Buffer, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, '0').slice(-6)
  header.write(`${encoded}\0 `, 148, 8, 'ascii')
}
