import { rm, stat, statfs, writeFile } from 'node:fs/promises'

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

/** True once written; a failed write is reported, never thrown. */
export function writeQuietly(path: string, text: string): Promise<boolean> {
  return writeFile(path, text).then(
    () => true,
    () => false
  )
}
