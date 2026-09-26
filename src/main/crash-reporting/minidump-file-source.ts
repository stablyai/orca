import type { FileHandle } from 'node:fs/promises'
import type { MinidumpSource } from './minidump-stream-reader'

const PAGE_BYTES = 64 * 1024

/** Size-zero readFile follows bytes until EOF, even when an open races the writer. */
export type MinidumpExtentObservationOptions = {
  readonly deadlineMs?: number
  readonly now?: () => number
}

export async function observeMinidumpExtent(
  handle: FileHandle,
  initialSize: number,
  options: MinidumpExtentObservationOptions = {}
): Promise<number> {
  if (initialSize !== 0) {
    return initialSize
  }
  const bytes = Buffer.allocUnsafe(PAGE_BYTES)
  let size = 0
  const now = options.now ?? Date.now
  while (true) {
    // A zero-length file still gets one read so a dump that is being promoted
    // can be captured; stop before the next page once the polling deadline wins.
    if (size > 0 && options.deadlineMs !== undefined && now() >= options.deadlineMs) {
      return size
    }
    const result = await handle.read(bytes, 0, bytes.length, size)
    if (result.bytesRead === 0) {
      return size
    }
    size += result.bytesRead
  }
}

/** Keep metadata seeks cheap without retaining the dump's captured process memory. */
export function createMinidumpFileSource(handle: FileHandle, byteLength: number): MinidumpSource {
  const pages = new Map<number, Buffer>()
  let extent = byteLength

  async function readRange(offset: number, size: number): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(size)
    let read = 0
    while (read < size) {
      const result = await handle.read(bytes, read, size - read, offset + read)
      if (result.bytesRead === 0) {
        extent = Math.min(extent, offset + read)
        break
      }
      read += result.bytesRead
    }
    return bytes.subarray(0, read)
  }

  async function pageAt(offset: number): Promise<Buffer> {
    const cached = pages.get(offset)
    if (cached) {
      pages.delete(offset)
      pages.set(offset, cached)
      return cached
    }
    const page = await readRange(offset, Math.min(PAGE_BYTES, extent - offset))
    pages.set(offset, page)
    if (pages.size > 4) {
      const oldest = pages.keys().next().value
      if (oldest !== undefined) {
        pages.delete(oldest)
      }
    }
    return page
  }

  return {
    get byteLength() {
      return extent
    },
    async read(offset, size) {
      const length = Math.max(0, Math.min(size, extent - offset))
      if (length === 0) {
        return Buffer.alloc(0)
      }
      if (length > PAGE_BYTES) {
        return readRange(offset, length)
      }
      const start = Math.floor(offset / PAGE_BYTES) * PAGE_BYTES
      const page = await pageAt(start)
      const inPage = offset - start
      if (inPage + length <= PAGE_BYTES || page.length < PAGE_BYTES) {
        return page.subarray(inPage, inPage + length)
      }
      const nextPage = await pageAt(start + PAGE_BYTES)
      return Buffer.concat([
        page.subarray(inPage),
        nextPage.subarray(0, length - (PAGE_BYTES - inPage))
      ])
    }
  }
}
