import { lstat } from 'node:fs/promises'
import { basename } from 'node:path'
import { isENOENT } from './filesystem-path-containment'

/** Translate raw filesystem errors, including exclusive-create EEXIST, into renderer-facing messages. */
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

/** Non-atomic existence check; createFile uses wx when an atomic alternative is available. */
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
