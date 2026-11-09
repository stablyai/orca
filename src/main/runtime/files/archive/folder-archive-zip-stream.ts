import { constants } from 'node:fs'
import { open, readlink } from 'node:fs/promises'
import { extname } from 'node:path'
import { Zip, ZipDeflate, ZipPassThrough, type ZipInputFile } from 'fflate'
import { isVanishedOrDenied, type FolderArchiveEntry } from './folder-archive-walk'

const FILE_READ_BYTES = 256 * 1024
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
    while (this.chunks.length > 0 && taken < maxBytes) {
      const head = this.chunks[0]
      const room = maxBytes - taken
      if (head.byteLength <= room) {
        parts.push(head)
        taken += head.byteLength
        this.chunks.shift()
      } else {
        parts.push(head.subarray(0, room))
        this.chunks[0] = head.subarray(room)
        taken += room
      }
    }
    this.bufferedBytes -= taken
    this.notifyProducer()
    return {
      bytes: Buffer.concat(parts, taken),
      eof: this.finished && this.chunks.length === 0
    }
  }

  cancel(): void {
    this.canceled = true
    this.zip.terminate()
    this.chunks.length = 0
    this.bufferedBytes = 0
    this.fail(new Error('archive_canceled'))
    this.notifyProducer()
  }

  private async produce(): Promise<void> {
    try {
      for (const entry of this.entries) {
        if (this.canceled) {
          return
        }
        await this.addEntry(entry)
      }
      this.zip.end()
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async addEntry(entry: FolderArchiveEntry): Promise<void> {
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
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(entry.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      return this.skip(error)
    }
    try {
      // A file swapped for something else after the walk is skipped, not archived.
      if (!(await handle.stat()).isFile()) {
        this.skippedCount += 1
        return
      }
      const file = withAttributes(
        STORED_EXTENSIONS.has(extname(entry.archivePath).toLowerCase())
          ? new ZipPassThrough(entry.archivePath)
          : new ZipDeflate(entry.archivePath, { level: DEFLATE_LEVEL }),
        entry,
        entry.mode
      )
      this.zip.add(file)
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

  private skip(error: unknown): void {
    if (!isVanishedOrDenied(error)) {
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
