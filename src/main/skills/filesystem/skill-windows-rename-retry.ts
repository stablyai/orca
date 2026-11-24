import { rename } from 'node:fs/promises'

const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200, 250]

export async function renameSkillPathWithWindowsRetry(
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
