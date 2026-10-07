import type { IFilesystemProvider } from '../providers/types'

/** Whether a remote path exists; only a definite "missing" answer reads as false. */
export async function remotePathExists(
  provider: IFilesystemProvider,
  remotePath: string
): Promise<boolean> {
  try {
    await provider.stat(remotePath)
    return true
  } catch (error) {
    if (isRemoteMissingError(error)) {
      return false
    }
    throw error
  }
}

function isRemoteMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return (
    ('code' in error && error.code === 'ENOENT') ||
    /\b(ENOENT|ENOTDIR)\b|no such file or directory|cannot find (?:the )?(?:file|path)|(?:file|path) not found/i.test(
      error.message
    )
  )
}
