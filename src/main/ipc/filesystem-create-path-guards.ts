import { lstat } from 'node:fs/promises'
import { basename } from 'node:path'
import { isENOENT } from './filesystem-path-containment'

/**
 * Re-throw filesystem errors with user-friendly messages.
 * The `wx` flag on writeFile throws a raw EEXIST with no helpful message,
 * so we catch it here and provide context the renderer can display directly.
 */
export function rethrowWithUserMessage(error: unknown, targetPath: string): never {
  const name = basename(targetPath)
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new Error(`A file or folder named '${name}' already exists in this location`)
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Permission denied: unable to create '${name}'`)
    }
  }
  throw error
}

/**
 * Ensure `targetPath` does not already exist. Throws if it does.
 *
 * Note: this is a non-atomic check — a concurrent operation could create the
 * path between `lstat` and the caller's next action. Acceptable for a desktop
 * app with low concurrency; `createFile` uses the `wx` flag for an atomic
 * alternative where possible.
 */
export async function assertNotExists(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
    throw new Error(
      `A file or folder named '${basename(targetPath)}' already exists in this location`
    )
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }
}
