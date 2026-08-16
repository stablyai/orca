import { copyFile, lstat, open } from 'node:fs/promises'
import { constants as fsConstants, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

// Why: TOCTOU symlink-swap defense — O_NOFOLLOW makes open() fail on a symlink; Windows lacks it, so fall back to copyFile.
export async function copyFileNoFollow(src: string, dest: string): Promise<void> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  if (noFollow === 0) {
    await copyFile(src, dest)
    return
  }
  const fh = await open(src, fsConstants.O_RDONLY | noFollow)
  try {
    await pipeline(fh.createReadStream({ autoClose: false }), createWriteStream(dest))
  } finally {
    await fh.close()
  }
}

export async function isSymlink(path: string): Promise<boolean> {
  try {
    const s = await lstat(path)
    return s.isSymbolicLink()
  } catch {
    return false
  }
}
