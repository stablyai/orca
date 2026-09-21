// Byte-level reads of one retained payload file: whole-file hashing, the file
// identity a verification is pinned to, and UTF-8 boundary alignment for a
// served range. Split out of journal-payload-store so the store stays the
// retention policy and this stays the file mechanics.

import { createHash } from 'node:crypto'
import { readSync, statSync } from 'node:fs'

/** The file identity a successful verification is pinned to. Any write — even
 *  one that preserves the size — changes the mtime or the inode, so a stale
 *  entry cannot survive a tampered file. */
export type VerifiedFileIdentity = { size: number; mtimeMs: number; ino: number; dev: number }

/** sha256 of the first `size` bytes behind `descriptor`, streamed so a large
 *  retained payload never lands in memory twice. */
export function hashDescriptor(descriptor: number, size: number): string {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(64 * 1024)
  let position = 0
  while (position < size) {
    const read = readSync(descriptor, buffer, 0, buffer.length, position)
    if (read <= 0) {
      break
    }
    hash.update(buffer.subarray(0, read))
    position += read
  }
  return hash.digest('hex')
}

/** Size plus the identity fields that change on any rewrite, so a verification
 *  can be pinned to the exact file it was computed from. */
export function fileIdentity(path: string): VerifiedFileIdentity {
  const info = statSync(path)
  return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev }
}

/** Most bytes a start alignment can skip: a UTF-8 sequence is at most 4 bytes,
 *  so at most 3 continuation bytes stand between an offset and the next lead
 *  byte. The federated reply binding holds peers to the same ceiling. */
export const MAX_UTF8_START_ALIGNMENT = 3

/** Walk forward from a byte position to the next UTF-8 lead byte, so a chunk
 *  never begins inside a multi-byte sequence. A caller-supplied offset that
 *  lands mid-character would otherwise decode to replacement characters and be
 *  served as if it were the payload's own content. Moves forward by at most
 *  `MAX_UTF8_START_ALIGNMENT`, and never past the end of the file. */
export function alignUtf8Start(descriptor: number, start: number, size: number): number {
  if (start <= 0 || start >= size) {
    return start
  }
  const probe = Buffer.alloc(1)
  let aligned = start
  while (aligned < size) {
    readSync(descriptor, probe, 0, 1, aligned)
    if ((probe[0] & 0b1100_0000) !== 0b1000_0000) {
      break
    }
    aligned += 1
  }
  return aligned
}

/** Walk back from a byte position so the chunk never ends inside a multi-byte
 *  UTF-8 sequence; the final byte of the file is always a valid end. */
export function alignUtf8End(descriptor: number, start: number, end: number, size: number): number {
  if (end >= size || end <= start) {
    return end
  }
  const probe = Buffer.alloc(1)
  let aligned = end
  while (aligned > start) {
    readSync(descriptor, probe, 0, 1, aligned)
    if ((probe[0] & 0b1100_0000) !== 0b1000_0000) {
      break
    }
    aligned -= 1
  }
  if (aligned > start) {
    return aligned
  }
  // The whole window fell inside one code point. A positive limit must still
  // advance, or the documented pager (`chunkOffset + chunkByteLength`) stalls on
  // an empty, incomplete chunk — so extend forward through that one character.
  aligned = end
  while (aligned < size) {
    readSync(descriptor, probe, 0, 1, aligned)
    if ((probe[0] & 0b1100_0000) !== 0b1000_0000) {
      break
    }
    aligned += 1
  }
  return aligned
}
