import { closeSync, openSync, readSync } from 'node:fs'
import { COMPRESSED_ROLLOUT_SUFFIX } from '../rollouts/codex-rollout-compressed-twin'

// Sync reads on purpose: this runs on the copies cleanup's own worker thread.
const CHUNK_BYTES = 1024 * 1024

/** Thrown when a comparison outlasts its launch's deadline; the copy waits for a later launch. */
export class OutOfTime extends Error {}

function* chunks(path: string): Generator<Buffer> {
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

/**
 * Whether every byte of `copy` is at the start of `original`, comparing the files' own bytes
 * (both plain or both `.zst`, never decoded). A plain copy may be a prefix the original grew past;
 * a `.zst` copy must be identical, since a compressed prefix is a damaged file.
 */
export function originalHoldsCopy(copy: string, original: string, deadline = Infinity): boolean {
  const theirs = chunks(original)
  try {
    let pending: Buffer = Buffer.alloc(0)
    for (const mine of chunks(copy)) {
      if (Date.now() > deadline) {
        throw new OutOfTime()
      }
      let offset = 0
      while (offset < mine.length) {
        if (pending.length === 0) {
          const next = theirs.next()
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
    return copy.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
      ? pending.length === 0 && theirs.next().done === true
      : true
  } finally {
    theirs.return(undefined)
  }
}
