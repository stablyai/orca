import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

// Windows AV/indexer rename locks need asynchronous backoff; the existing retry primitive is synchronous (#1507).

const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200, 250]

export type PluginAtomicWriteOptions = { mode?: number }

export async function writePluginFileAtomically(
  target: string,
  contents: string,
  options?: PluginAtomicWriteOptions
): Promise<void> {
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
