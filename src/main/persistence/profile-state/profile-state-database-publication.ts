import { dirname } from 'node:path'
import { publishFileDurableSync } from '../../durable-file-write'
import { profileStatePublicationFailureText } from './profile-state-startup-failure'

class ProfileStateDatabasePublicationError extends Error {
  readonly code = 'profile-state-publication-unavailable' as const
  readonly directory: string

  constructor(databaseFile: string, cause: unknown) {
    super(profileStatePublicationFailureText(dirname(databaseFile)), { cause })
    this.name = 'ProfileStateDatabasePublicationError'
    this.directory = dirname(databaseFile)
  }
}

/** Explain filesystem refusals without weakening atomic no-overwrite publication. */
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
