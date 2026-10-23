import { lstat } from 'node:fs/promises'

/** Recover beside corrupt entries; a published path may still belong to another reader. */
export async function findOrcadCachePath(
  candidate: (attempt: number) => string,
  isValid: (path: string) => Promise<boolean>
): Promise<{ path: string; verified: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const path = candidate(attempt)
    if (await isValid(path)) {
      return { path, verified: true }
    }
    try {
      await lstat(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { path, verified: false }
      }
      throw error
    }
  }
}
