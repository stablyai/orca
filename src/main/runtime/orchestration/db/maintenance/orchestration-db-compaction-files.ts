import { rm, stat, statfs } from 'node:fs/promises'
import { durableWriteTempPath, writeFileDurable } from '../../../../filesystem/durable-file-write'

export async function availableBytesIn(dir: string): Promise<number> {
  try {
    const disk = await statfs(dir)
    return Number(disk.bavail) * Number(disk.bsize)
  } catch {
    return 0
  }
}

export async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

export function removeQuietly(path: string): Promise<void> {
  return rm(path, { force: true }).catch(() => {})
}

/** True once written; replaced whole, so a failed write leaves the last complete text, and never throws. */
export function writeQuietly(path: string, text: string): Promise<boolean> {
  return writeFileDurable(durableWriteTempPath(path), path, text).then(
    () => true,
    () => false
  )
}
