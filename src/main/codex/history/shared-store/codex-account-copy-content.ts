import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { COMPRESSED_ROLLOUT_SUFFIX } from '../rollouts/codex-rollout-compressed-twin'

// Sync reads on purpose: this runs on the copies cleanup's own worker thread.
const CHUNK_BYTES = 1024 * 1024
const NEWLINE = 0x0a
const ZSTD_MAGIC = 0xfd2fb528

/**
 * The content size a zstd file's first frame declares, null when it declares none. A damaged
 * frame decodes to less; a file of several frames decodes to more.
 */
export function zstdDeclaredSize(path: string): bigint | null {
  const header = Buffer.alloc(18)
  const fd = openSync(path, 'r')
  let read: number
  try {
    read = readSync(fd, header, 0, header.length, 0)
  } finally {
    closeSync(fd)
  }
  if (read < 5 || header.readUInt32LE(0) !== ZSTD_MAGIC) {
    return null
  }
  const descriptor = header[4]
  const singleSegment = (descriptor & 0x20) !== 0
  const sizeFlag = descriptor >> 6
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03]
  const sizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][sizeFlag]
  const at = 5 + (singleSegment ? 0 : 1) + dictionaryBytes
  if (sizeBytes === 0 || at + sizeBytes > read) {
    return null
  }
  switch (sizeBytes) {
    case 1:
      return BigInt(header[at])
    case 2:
      return BigInt(header.readUInt16LE(at) + 256)
    case 4:
      return BigInt(header.readUInt32LE(at))
    default:
      return header.readBigUInt64LE(at)
  }
}

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
 * grew past. Compares decompressed content when the forms differ, raw bytes when they match; two
 * `.zst` files must be identical (a compressed prefix is a damaged file), and a `.zst` original
 * must decode to its end, so a damaged tail never stands in for a readable copy.
 */
/** Thrown when a comparison outlasts its launch's deadline; the copy waits for a later launch. */
export class OutOfTime extends Error {}

export async function originalHoldsCopy(
  copy: string,
  original: string,
  deadline = Infinity
): Promise<boolean> {
  const inTime = (): void => {
    if (Date.now() > deadline) {
      throw new OutOfTime()
    }
  }
  const sameForm =
    copy.endsWith(COMPRESSED_ROLLOUT_SUFFIX) === original.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
  const read = sameForm ? plainChunks : contentChunks
  const theirs = read(original)
  try {
    let pending: Buffer = Buffer.alloc(0)
    let consumed = 0
    let lastByte: number | undefined
    for await (const mine of read(copy)) {
      inTime()
      let offset = 0
      while (offset < mine.length) {
        if (pending.length === 0) {
          const next = await theirs.next()
          if (next.done) {
            return false
          }
          pending = next.value
          lastByte = pending.at(-1) ?? lastByte
          continue
        }
        const length = Math.min(mine.length - offset, pending.length)
        if (!mine.subarray(offset, offset + length).equals(pending.subarray(0, length))) {
          return false
        }
        offset += length
        consumed += length
        pending = pending.subarray(length)
      }
    }
    const compressed = original.endsWith(COMPRESSED_ROLLOUT_SUFFIX)
    if (sameForm && compressed) {
      return pending.length === 0 && (await theirs.next()).done === true
    }
    if (compressed) {
      // The decoder ends a truncated frame quietly, so the whole original is measured.
      let total = BigInt(consumed + pending.length)
      let last = pending.at(-1) ?? lastByte
      for (let next = await theirs.next(); !next.done; next = await theirs.next()) {
        inTime()
        total += BigInt(next.value.length)
        last = next.value.at(-1) ?? last
      }
      const declared = zstdDeclaredSize(original)
      return declared === total || ((declared === null || total > declared) && last === NEWLINE)
    }
    return true
  } finally {
    await theirs.return(undefined)
  }
}
