import { open } from 'node:fs/promises'

const CHUNK_BYTES = 64 * 1024

/** Whether `fullPath` starts with every byte of `prefixPath`: it then holds the whole of it. */
export async function isRolloutBytePrefix(prefixPath: string, fullPath: string): Promise<boolean> {
  const prefix = await open(prefixPath, 'r')
  const full = await open(fullPath, 'r').catch(async (error: unknown) => {
    await prefix.close()
    throw error
  })
  try {
    const [prefixStat, fullStat] = await Promise.all([prefix.stat(), full.stat()])
    if (prefixStat.size > fullStat.size) {
      return false
    }
    const left = Buffer.alloc(CHUNK_BYTES)
    const right = Buffer.alloc(CHUNK_BYTES)
    for (let offset = 0; offset < prefixStat.size; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, prefixStat.size - offset)
      const [read, readFull] = await Promise.all([
        prefix.read(left, 0, length, offset),
        full.read(right, 0, length, offset)
      ])
      if (
        read.bytesRead !== length ||
        readFull.bytesRead !== length ||
        !left.subarray(0, length).equals(right.subarray(0, length))
      ) {
        return false
      }
    }
    return true
  } finally {
    await Promise.all([prefix.close(), full.close()])
  }
}
