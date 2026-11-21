import type { BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'

const COMPARE_CHUNK_BYTES = 1024 * 1024

/** True when the source starts with every byte of the copy whose stats are `copy`. */
export async function sourceStartsWithCopy(
  copyPath: string,
  sourcePath: string,
  copy: BigIntStats
): Promise<boolean> {
  const copyFile = await open(copyPath, 'r')
  try {
    const sourceFile = await open(sourcePath, 'r')
    try {
      const [opened, source] = await Promise.all([
        copyFile.stat({ bigint: true }),
        sourceFile.stat({ bigint: true })
      ])
      if (opened.dev !== copy.dev || opened.ino !== copy.ino) {
        throw new Error('The legacy copy changed while it was opened.')
      }
      const size = Number(copy.size)
      if (source.size < copy.size) {
        return false
      }
      const copyChunk = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK_BYTES, size))
      const sourceChunk = Buffer.allocUnsafe(copyChunk.length)
      for (let offset = 0; offset < size; offset += copyChunk.length) {
        const length = Math.min(copyChunk.length, size - offset)
        const [fromCopy, fromSource] = await Promise.all([
          copyFile.read(copyChunk, 0, length, offset),
          sourceFile.read(sourceChunk, 0, length, offset)
        ])
        if (
          fromCopy.bytesRead !== length ||
          fromSource.bytesRead !== length ||
          !copyChunk.subarray(0, length).equals(sourceChunk.subarray(0, length))
        ) {
          return false
        }
      }
      return true
    } finally {
      await sourceFile.close()
    }
  } finally {
    await copyFile.close()
  }
}
