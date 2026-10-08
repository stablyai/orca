import { open, opendir, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

export const PACK_INDEX_PROBE_ENTRY_LIMIT = 65_536
export const PACK_INDEX_PROBE_TIMEOUT_MS = 1_000

export function isMissingPackIndexPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export async function readRepoPackDirectoryStamp(directory: string): Promise<string | undefined> {
  try {
    const value = await stat(directory, { bigint: true })
    return `${value.dev}:${value.ino}:${value.mtimeNs}:${value.ctimeNs}`
  } catch (error) {
    if (isMissingPackIndexPath(error)) {
      return undefined
    }
    throw error
  }
}

async function hasUnsupportedPackIndex(directory: string): Promise<boolean> {
  const paths = isWindowsAbsolutePathLike(directory) ? win32 : posix
  const handle = await open(paths.join(directory, 'multi-pack-index'), 'r').catch(
    (error: unknown) => {
      if (isMissingPackIndexPath(error)) {
        return undefined
      }
      throw error
    }
  )
  if (!handle) {
    return false
  }
  try {
    const header = Buffer.alloc(12)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const hashBytes = header[5] === 1 ? 20 : header[5] === 2 ? 32 : 0
    const chunks = header[6] ?? 0
    const size = (await handle.stat()).size
    if (
      bytesRead !== header.length ||
      header.subarray(0, 4).toString() !== 'MIDX' ||
      header[4] !== 1 ||
      !hashBytes ||
      chunks < 4 ||
      header[7] !== 0 ||
      size < 12 + (chunks + 1) * 12 + 1024 + hashBytes
    ) {
      return true
    }
    const trailer = Buffer.alloc(hashBytes)
    return (await handle.read(trailer, 0, hashBytes, size - hashBytes)).bytesRead !== hashBytes
  } finally {
    await handle.close()
  }
}

/** A capped name walk protects every retained bitmap, including an older index's bitmap. */
export async function probeRepoPackIndexDirectory(
  directory: string,
  packThreshold: number,
  signal: AbortSignal
): Promise<{ packCountFloor: number; protected: boolean }> {
  const entries = await opendir(directory)
  const startedAt = Date.now()
  let visited = 0
  let packCountFloor = 0
  for await (const entry of entries) {
    if (signal.aborted) {
      return { packCountFloor, protected: true }
    }
    if (
      entry.name === 'multi-pack-index.d' ||
      (entry.name.startsWith('multi-pack-index') && entry.name.endsWith('.bitmap')) ||
      (entry.name === 'multi-pack-index' && !entry.isFile())
    ) {
      return { packCountFloor, protected: true }
    }
    if (entry.name.endsWith('.pack') && (entry.isFile() || entry.isSymbolicLink())) {
      packCountFloor = Math.min(packThreshold, packCountFloor + 1)
    }
    visited += 1
    if (
      visited >= PACK_INDEX_PROBE_ENTRY_LIMIT ||
      Date.now() - startedAt >= PACK_INDEX_PROBE_TIMEOUT_MS
    ) {
      return { packCountFloor, protected: true }
    }
  }
  return { packCountFloor, protected: await hasUnsupportedPackIndex(directory) }
}
