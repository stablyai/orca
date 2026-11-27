import { closeSync, openSync, readSync } from 'node:fs'
import { COMPRESSED_ROLLOUT_SUFFIX } from '../rollouts/codex-rollout-compressed-twin'

// Sync reads on purpose: this runs on the copies cleanup's own worker thread.
const CHUNK_BYTES = 1024 * 1024

/** `partial`: the first `matched` bytes agree and the rest wasn't read (time or bytes ran out). */
export type CompareResult = { holds: boolean } | { partial: true; matched: number }

function* chunks(path: string, start: number, limit: number): Generator<Buffer> {
  const fd = openSync(path, 'r')
  try {
    for (let position = start, left = limit; left > 0;) {
      const want = Math.min(CHUNK_BYTES, left)
      const chunk = Buffer.allocUnsafe(want)
      const read = readSync(fd, chunk, 0, want, position)
      if (read === 0) {
        return
      }
      left -= read
      position += read
      yield chunk.subarray(0, read)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Whether every byte of `copy` is at the start of `original`, comparing the files' own bytes
 * (both plain or both `.zst`, never decoded). A plain copy may be a prefix the original grew past;
 * a `.zst` copy must be identical, since a compressed prefix is a damaged file. Starts at `from`
 * (bytes an earlier launch matched, with both files unchanged since) and reads at most `maxBytes`
 * of the copy before returning partial progress, as it does past `deadline`.
 */
export function originalHoldsCopy(
  copy: string,
  original: string,
  copySize: bigint,
  options: { from?: number; maxBytes?: number; deadline?: number } = {}
): CompareResult {
  const size = Number(copySize)
  const from = options.from ?? 0
  const deadline = options.deadline ?? Infinity
  const end = Math.min(size, from + Math.max(1, options.maxBytes ?? Infinity))
  const compressed = copy.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
  // One more byte of a `.zst` original past the copy's end, to see it isn't longer.
  const theirs = chunks(original, from, end - from + (compressed && end === size ? 1 : 0))
  let matched = from
  try {
    let pending: Buffer = Buffer.alloc(0)
    for (const mine of chunks(copy, from, end - from)) {
      if (Date.now() > deadline) {
        return { partial: true, matched }
      }
      let offset = 0
      while (offset < mine.length) {
        if (pending.length === 0) {
          const next = theirs.next()
          if (next.done) {
            return { holds: false }
          }
          pending = next.value
          continue
        }
        const length = Math.min(mine.length - offset, pending.length)
        if (!mine.subarray(offset, offset + length).equals(pending.subarray(0, length))) {
          return { holds: false }
        }
        offset += length
        pending = pending.subarray(length)
      }
      matched += mine.length
    }
    if (matched < size) {
      return end < size ? { partial: true, matched } : { holds: false }
    }
    return { holds: compressed ? pending.length === 0 && theirs.next().done === true : true }
  } finally {
    theirs.return(undefined)
  }
}
