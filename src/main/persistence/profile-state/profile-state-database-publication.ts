import { dirname } from 'node:path'
import { publishFileDurableSync } from '../../durable-file-write'

class ProfileStateDatabasePublicationError extends Error {
  readonly code = 'profile-state-publication-unavailable' as const

  constructor(databaseFile: string, cause: unknown) {
    super(
      [
        `Orca could not safely publish profile state in ${dirname(databaseFile)}.`,
        'This location must support hard links, and Orca needs permission to create them.',
        'Close Orca and orcad before checking folder permissions or moving the complete Orca data directory to a writable local filesystem that supports hard links, such as APFS, NTFS, or ext4.',
        'Keep the original directory and all recovery files.'
      ].join('\n'),
      { cause }
    )
    this.name = 'ProfileStateDatabasePublicationError'
  }
}

/** Preserve atomic no-overwrite publication while explaining filesystem refusals. */
export function publishProfileStateDatabase(stagingFile: string, databaseFile: string): boolean {
  try {
    return publishFileDurableSync(stagingFile, databaseFile)
  } catch (error) {
    if (
      error instanceof Error &&
      'syscall' in error &&
      error.syscall === 'link' &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EACCES', 'EXDEV'].includes(error.code)
    ) {
      throw new ProfileStateDatabasePublicationError(databaseFile, error)
    }
    throw error
  }
}
