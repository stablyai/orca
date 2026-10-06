import type { DirEntry } from '../../shared/filesystem-entry-types'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { requestGitStreamable } from '../ssh/ssh-git-response-stream-reader'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import { validateDirectoryListing } from '../../shared/directory-listing-budget'
import { readSftpDirectory } from './ssh-sftp-filesystem-provider'
import type { SftpFactory } from './ssh-filesystem-download'

export function readSshDirectoryWithSftpFallback(
  mux: SshChannelMultiplexer,
  dirPath: string,
  createSftp?: SftpFactory,
  options?: { followSymlinks?: boolean }
): Promise<DirEntry[]> {
  return readSshDirectoryBounded(
    mux,
    dirPath,
    createSftp
      ? async () => {
          const sftp = await createSftp()
          try {
            return await readSftpDirectory(sftp, dirPath, options)
          } finally {
            sftp.end()
          }
        }
      : undefined,
    options
  )
}

export async function readSshDirectoryBounded(
  mux: SshChannelMultiplexer,
  dirPath: string,
  fallback?: () => Promise<DirEntry[]>,
  options?: { followSymlinks?: boolean }
) {
  try {
    return validateDirectoryListing(
      await requestGitStreamable(
        mux,
        'fs.readDirBounded',
        { dirPath, ...options },
        { maxResponseBytes: 16 * 1024 * 1024 }
      )
    )
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      if (fallback) {
        return fallback()
      }
      // Old hosts allocate before replying; bound transport retention and validate the complete result.
      return validateDirectoryListing(
        await requestGitStreamable(
          mux,
          'fs.readDir',
          { dirPath, ...options },
          {
            maxResponseBytes: 16 * 1024 * 1024
          }
        )
      )
    }
    throw error
  }
}
