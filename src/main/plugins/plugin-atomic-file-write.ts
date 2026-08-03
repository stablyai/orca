import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

/**
 * Atomic write for plugin state files (lockfile, provenance, pointers, caches).
 *
 * Why the retry: on Windows the rename can fail with EPERM/EACCES/EBUSY while
 * antivirus or an indexer holds the target open (issue #1507). The repo's
 * existing `renameFileWithWindowsRetry` covers the same hazard but is sync;
 * every plugin write path is async, so the backoff parks on a timer instead.
 */

const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200, 250]

export type PluginAtomicWriteOptions = { mode?: number }

export async function writePluginFileAtomically(
  target: string,
  contents: string,
  options?: PluginAtomicWriteOptions
): Promise<void> {
  // Unique temp name so concurrent writers in one plugins dir cannot collide.
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: options?.mode })
    await renamePluginFileWithWindowsRetry(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function renamePluginFileWithWindowsRetry(
  source: string,
  target: string
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (
        process.platform !== 'win32' ||
        !retryable ||
        attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length
      ) {
        throw error
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, WINDOWS_RENAME_RETRY_DELAYS_MS[attempt])
      )
    }
  }
}
