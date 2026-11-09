import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import type { ThreadCopy } from './codex-thread-copies'

export function openContent(copy: Pick<ThreadCopy, 'path' | 'compressed'>): Readable {
  const file = createReadStream(copy.path)
  if (!copy.compressed) {
    return file
  }
  const decompress = createZstdDecompress()
  file.on('error', (error) => decompress.destroy(error))
  return file.pipe(decompress)
}

export type PrefixRelation = 'same' | 'left-extends' | 'right-extends' | 'diverged'

/** Streams both decompressed contents once; reports which one, if either, extends the other. */
async function comparePrefix(
  left: Pick<ThreadCopy, 'path' | 'compressed'>,
  right: Pick<ThreadCopy, 'path' | 'compressed'>
): Promise<PrefixRelation> {
  const leftIterator = openContent(left)[Symbol.asyncIterator]()
  const rightIterator = openContent(right)[Symbol.asyncIterator]()
  let leftChunk: Buffer = Buffer.alloc(0)
  let rightChunk: Buffer = Buffer.alloc(0)
  let leftDone = false
  let rightDone = false
  try {
    for (;;) {
      if (leftChunk.length === 0 && !leftDone) {
        const next = await leftIterator.next()
        leftDone = Boolean(next.done)
        leftChunk = next.done ? Buffer.alloc(0) : asBuffer(next.value)
        continue
      }
      if (rightChunk.length === 0 && !rightDone) {
        const next = await rightIterator.next()
        rightDone = Boolean(next.done)
        rightChunk = next.done ? Buffer.alloc(0) : asBuffer(next.value)
        continue
      }
      if (leftChunk.length === 0 || rightChunk.length === 0) {
        if (leftChunk.length === 0 && rightChunk.length === 0) {
          return 'same'
        }
        return leftChunk.length === 0 ? 'right-extends' : 'left-extends'
      }
      const length = Math.min(leftChunk.length, rightChunk.length)
      if (!leftChunk.subarray(0, length).equals(rightChunk.subarray(0, length))) {
        return 'diverged'
      }
      leftChunk = leftChunk.subarray(length)
      rightChunk = rightChunk.subarray(length)
    }
  } finally {
    await Promise.allSettled([leftIterator.return?.(), rightIterator.return?.()])
  }
}

export async function contentRelation(
  left: ThreadCopy,
  right: ThreadCopy
): Promise<PrefixRelation> {
  if (left.dev === right.dev && left.ino === right.ino) {
    return 'same'
  }
  return comparePrefix(left, right)
}

// File and zstd streams emit Buffers; anything else is a stream misuse.
function asBuffer(chunk: unknown): Buffer {
  if (!Buffer.isBuffer(chunk)) {
    throw new TypeError('Expected a Buffer chunk from a rollout stream')
  }
  return chunk
}
