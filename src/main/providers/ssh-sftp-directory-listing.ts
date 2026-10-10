import type { SFTPWrapper } from 'ssh2'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import { DirectoryListingBudget } from '../../shared/directory-listing-budget'
import { sortDirEntries } from '../../shared/file-name-sort'
import { readDirectoryEntriesViaSftp, statViaSftp } from './ssh-filesystem-provider-sftp'

export async function readSftpDirectory(
  sftp: SFTPWrapper,
  path: string,
  options?: { followSymlinks?: boolean; signal?: AbortSignal }
): Promise<DirEntry[]> {
  const budget = new DirectoryListingBudget()
  const mapped: DirEntry[] = []
  for await (const entry of readDirectoryEntriesViaSftp(sftp, path, options)) {
    budget.record(entry.filename)
    const isSymlink = entry.attrs.isSymbolicLink()
    let isDirectory = entry.attrs.isDirectory()
    if (isSymlink && options?.followSymlinks !== false) {
      isDirectory = await statViaSftp(sftp, `${path.replace(/\/$/, '')}/${entry.filename}`, options)
        .then((stats) => stats.isDirectory())
        .catch(() => false)
    }
    mapped.push({ name: entry.filename, isDirectory, isSymlink })
  }
  options?.signal?.throwIfAborted()
  return sortDirEntries(mapped)
}
