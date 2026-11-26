import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { COMPRESSED_ROLLOUT_SUFFIX } from '../rollouts/codex-rollout-compressed-twin'

// Sync reads on purpose: this runs on the copies cleanup's own worker thread.
const CHUNK_BYTES = 1024 * 1024

async function* plainChunks(path: string): AsyncGenerator<Buffer> {
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
      const read = readSync(fd, chunk, 0, CHUNK_BYTES, null)
      if (read === 0) {
        return
      }
      yield chunk.subarray(0, read)
    }
  } finally {
    closeSync(fd)
  }
}

async function* contentChunks(path: string): AsyncGenerator<Buffer> {
  if (!path.endsWith(COMPRESSED_ROLLOUT_SUFFIX)) {
    yield* plainChunks(path)
    return
  }
  const raw = createReadStream(path, { highWaterMark: CHUNK_BYTES })
  const decompressed = raw.pipe(createZstdDecompress())
  raw.on('error', (error) => decompressed.destroy(error))
  try {
    for await (const chunk of decompressed) {
      if (Buffer.isBuffer(chunk)) {
        yield chunk
      }
    }
  } finally {
    raw.destroy()
    decompressed.destroy()
  }
}

/**
 * Whether every byte of `copy` is at the start of `original`: identical, or a prefix the original
 * grew past. Compares decompressed content when the forms differ, raw bytes when they match.
 */
export async function originalHoldsCopy(copy: string, original: string): Promise<boolean> {
  const sameForm =
    copy.endsWith(COMPRESSED_ROLLOUT_SUFFIX) === original.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
  const read = sameForm ? plainChunks : contentChunks
  const theirs = read(original)
  try {
    let pending: Buffer = Buffer.alloc(0)
    for await (const mine of read(copy)) {
      let offset = 0
      while (offset < mine.length) {
        if (pending.length === 0) {
          const next = await theirs.next()
          if (next.done) {
            return false
          }
          pending = next.value
          continue
        }
        const length = Math.min(mine.length - offset, pending.length)
        if (!mine.subarray(offset, offset + length).equals(pending.subarray(0, length))) {
          return false
        }
        offset += length
        pending = pending.subarray(length)
      }
    }
    return true
  } finally {
    await theirs.return(undefined)
  }
}
