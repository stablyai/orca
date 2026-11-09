import { readlink, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import { Zip, ZipDeflate, ZipPassThrough, type ZipInputFile } from 'fflate'
import { isVanishedOrDenied, type FolderArchiveEntry } from './folder-archive-walk'
import {
  ChangedSinceWalkError,
  isSmallFile,
  openUnchangedFile,
  readSmallFile,
  type SmallFileRead
} from './folder-archive-file-reads'

const FILE_READ_BYTES = 256 * 1024
/** Small files read ahead at once; bounds look-ahead memory to about 2 MiB. */
const PREFETCH_WINDOW = 32
/** Encoded bytes buffered ahead of the reader before the producer pauses. */
const DEFAULT_HIGH_WATER_BYTES = 8 * 1024 * 1024
// Level 4 keeps pure-JS deflate fast enough not to starve a fast link while still shrinking text.
const DEFLATE_LEVEL = 4
const UNIX_OS = 3
const S_IFLNK = 0o120000
// Recompressing these costs CPU for no size win.
const STORED_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.br',
  '.bz2',
  '.dmg',
  '.gif',
  '.gz',
  '.heic',
  '.jar',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.png',
  '.rar',
  '.tgz',
  '.webm',
  '.webp',
  '.whl',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
  '.zst'
])

/**
 * Turns a planned entry list into ZIP bytes on demand. The producer runs ahead of the reader by at
 * most `highWaterBytes`, so a slow link never makes the host buffer a whole folder.
 */
export class FolderArchiveZipStream {
  private readonly chunks: Uint8Array[] = []
  // Head index instead of shift(): a folder of small files leaves thousands of tiny chunks queued.
  private chunkHead = 0
  private bufferedBytes = 0
  private finished = false
  private failure: Error | null = null
  private canceled = false
  private wakeReader: (() => void) | null = null
  private wakeProducer: (() => void) | null = null
  private readonly zip: Zip
  processedBytes = 0
  skippedCount = 0

  constructor(
    private readonly entries: readonly FolderArchiveEntry[],
    private readonly highWaterBytes = DEFAULT_HIGH_WATER_BYTES
  ) {
    this.zip = new Zip((error, data, final) => {
      if (error) {
        this.fail(error)
        return
      }
      if (data.byteLength > 0) {
        this.chunks.push(data)
        this.bufferedBytes += data.byteLength
      }
      if (final) {
        this.finished = true
      }
      this.notifyReader()
    })
    void this.produce()
  }

  /** Resolves with up to `maxBytes` once that much is buffered or the archive ends. */
  async read(maxBytes: number): Promise<{ bytes: Buffer; eof: boolean }> {
    while (!this.failure && !this.finished && this.bufferedBytes < maxBytes) {
      await new Promise<void>((resolve) => {
        this.wakeReader = resolve
      })
    }
    if (this.failure) {
      throw this.failure
    }
    const parts: Uint8Array[] = []
    let taken = 0
    while (this.chunkHead < this.chunks.length && taken < maxBytes) {
      const head = this.chunks[this.chunkHead]
      const room = maxBytes - taken
      if (head.byteLength <= room) {
        parts.push(head)
        taken += head.byteLength
        this.chunkHead += 1
      } else {
        parts.push(head.subarray(0, room))
        this.chunks[this.chunkHead] = head.subarray(room)
        taken += room
      }
    }
    if (this.chunkHead > 1024 || this.chunkHead === this.chunks.length) {
      this.chunks.splice(0, this.chunkHead)
      this.chunkHead = 0
    }
    this.bufferedBytes -= taken
    this.notifyProducer()
    return {
      bytes: Buffer.concat(parts, taken),
      eof: this.finished && this.chunkHead >= this.chunks.length
    }
  }

  cancel(): void {
    this.canceled = true
    this.zip.terminate()
    this.chunks.length = 0
    this.chunkHead = 0
    this.bufferedBytes = 0
    this.fail(new Error('archive_canceled'))
    this.notifyProducer()
  }

  private async produce(): Promise<void> {
    const prefetched = new Map<number, Promise<SmallFileRead>>()
    try {
      for (let index = 0; index < this.entries.length; index += 1) {
        if (this.canceled) {
          return
        }
        // Keep the next few small files' reads in flight while this entry is zipped.
        for (
          let ahead = index;
          ahead < index + PREFETCH_WINDOW && ahead < this.entries.length;
          ahead += 1
        ) {
          const next = this.entries[ahead]
          if (!prefetched.has(ahead) && isSmallFile(next)) {
            prefetched.set(ahead, readSmallFile(next))
          }
        }
        const small = prefetched.get(index)
        prefetched.delete(index)
        await this.addEntry(this.entries[index], small ? await small : undefined)
      }
      this.zip.end()
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async addEntry(entry: FolderArchiveEntry, small?: SmallFileRead): Promise<void> {
    if (entry.kind === 'directory') {
      const file = withAttributes(new ZipPassThrough(entry.archivePath), entry, entry.mode)
      this.zip.add(file)
      file.push(new Uint8Array(0), true)
      return
    }
    if (entry.kind === 'symlink') {
      let target: string
      try {
        target = await readlink(entry.absolutePath)
      } catch (error) {
        return this.skip(error)
      }
      // Stored as a link, never dereferenced: the target may name anything on the host.
      const file = withAttributes(
        new ZipPassThrough(entry.archivePath),
        entry,
        S_IFLNK | (entry.mode & 0o777)
      )
      this.zip.add(file)
      file.push(new TextEncoder().encode(target), true)
      return
    }
    if (small?.kind === 'skip') {
      return this.skip(small.error)
    }
    if (small?.kind === 'bytes') {
      await this.waitForRoom()
      if (this.canceled) {
        return
      }
      const file = this.addFileEntry(entry)
      this.processedBytes += small.bytes.byteLength
      file.push(small.bytes, true)
      return
    }
    let handle: FileHandle
    try {
      handle = await openUnchangedFile(entry)
    } catch (error) {
      return this.skip(error)
    }
    try {
      const file = this.addFileEntry(entry)
      const buffer = Buffer.allocUnsafe(FILE_READ_BYTES)
      for (;;) {
        await this.waitForRoom()
        if (this.canceled) {
          return
        }
        const { bytesRead } = await handle.read(buffer, 0, FILE_READ_BYTES, null)
        if (bytesRead === 0) {
          file.push(new Uint8Array(0), true)
          return
        }
        this.processedBytes += bytesRead
        // fflate may keep a reference until it deflates, so hand it a copy.
        file.push(Uint8Array.prototype.slice.call(buffer, 0, bytesRead) as Uint8Array, false)
      }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  private addFileEntry(entry: FolderArchiveEntry): ZipPassThrough | ZipDeflate {
    const file = withAttributes(
      STORED_EXTENSIONS.has(extname(entry.archivePath).toLowerCase())
        ? new ZipPassThrough(entry.archivePath)
        : new ZipDeflate(entry.archivePath, { level: DEFLATE_LEVEL }),
      entry,
      entry.mode
    )
    this.zip.add(file)
    return file
  }

  private skip(error: unknown): void {
    if (!(error instanceof ChangedSinceWalkError) && !isVanishedOrDenied(error)) {
      throw error
    }
    this.skippedCount += 1
  }

  private async waitForRoom(): Promise<void> {
    while (!this.canceled && this.bufferedBytes >= this.highWaterBytes) {
      await new Promise<void>((resolve) => {
        this.wakeProducer = resolve
      })
    }
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.notifyReader()
  }

  private notifyReader(): void {
    const wake = this.wakeReader
    this.wakeReader = null
    wake?.()
  }

  private notifyProducer(): void {
    const wake = this.wakeProducer
    this.wakeProducer = null
    wake?.()
  }
}

function withAttributes<T extends ZipInputFile>(
  file: T,
  entry: FolderArchiveEntry,
  mode: number
): T {
  file.os = UNIX_OS
  file.attrs = (mode & 0xffff) << 16
  file.mtime = clampZipMtime(entry.mtimeMs)
  return file
}

// DOS timestamps cover 1980-2107; fflate throws outside that range.
function clampZipMtime(mtimeMs: number): number {
  const min = Date.UTC(1980, 0, 2)
  const max = Date.UTC(2107, 11, 30)
  return Math.min(Math.max(mtimeMs, min), max)
}
