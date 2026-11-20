import { open, rm, stat, statfs } from 'node:fs/promises'

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

/** Makes the rename durable; Windows can't open a directory and its renames are already written through. */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  try {
    const handle = await open(dir, 'r')
    await handle.sync().finally(() => handle.close())
  } catch {
    // Some file systems refuse to sync a directory; the rename itself already happened.
  }
}

/** The work's result, or 'late' when it hasn't settled within `ms`. */
export async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}
