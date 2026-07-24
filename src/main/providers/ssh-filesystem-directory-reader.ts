import type { DirEntry } from '../../shared/types'
import {
  assertFilesystemDirectoryWithinLimit,
  resolveFilesystemDirectoryListingLimits
} from '../../shared/filesystem-directory-listing-limit'
import {
  assertMobileFileDirectoryWithinLimit,
  MOBILE_FILE_DIRECTORY_MAX_ENTRIES,
  MOBILE_FILE_DIRECTORY_MAX_RETAINED_BYTES
} from '../../shared/mobile-file-directory-limit'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export const SSH_BOUNDED_READ_DIR_UNAVAILABLE_MESSAGE =
  'Safe remote directory browsing requires an updated relay. Reconnect the SSH target before retrying.'

export class SshFilesystemDirectoryReader {
  private boundedMethodUnavailable = false

  constructor(private readonly mux: SshChannelMultiplexer) {}

  async readDir(
    dirPath: string,
    options?: { maxEntries?: number; maxRetainedBytes?: number }
  ): Promise<DirEntry[]> {
    if (this.boundedMethodUnavailable) {
      throw new Error(SSH_BOUNDED_READ_DIR_UNAVAILABLE_MESSAGE)
    }
    const mobileLimits =
      options?.maxEntries === MOBILE_FILE_DIRECTORY_MAX_ENTRIES &&
      options.maxRetainedBytes === MOBILE_FILE_DIRECTORY_MAX_RETAINED_BYTES
    const limits = mobileLimits
      ? {
          maxEntries: MOBILE_FILE_DIRECTORY_MAX_ENTRIES,
          maxRetainedBytes: MOBILE_FILE_DIRECTORY_MAX_RETAINED_BYTES
        }
      : resolveFilesystemDirectoryListingLimits(options)
    let entries: DirEntry[]
    try {
      entries = (await this.mux.request('fs.readDirBounded', {
        dirPath,
        ...limits
      })) as DirEntry[]
    } catch (error) {
      if (!isMethodNotFoundError(error)) {
        throw error
      }
      // Why: fallback would restore remote-side unbounded enumeration.
      this.boundedMethodUnavailable = true
      throw new Error(SSH_BOUNDED_READ_DIR_UNAVAILABLE_MESSAGE)
    }
    if (mobileLimits) {
      assertMobileFileDirectoryWithinLimit(entries)
    } else {
      assertFilesystemDirectoryWithinLimit(entries, limits)
    }
    return entries
  }
}
