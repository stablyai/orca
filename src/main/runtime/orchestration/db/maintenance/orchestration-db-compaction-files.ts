import { rm, stat, statfs } from 'node:fs/promises'

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
