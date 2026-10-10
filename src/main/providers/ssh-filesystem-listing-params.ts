import type { IFilesystemProvider } from './types'

export function sshFilesystemListingParams(
  rootPath: string,
  options?: Parameters<IFilesystemProvider['listFiles']>[1]
): Record<string, unknown> {
  return {
    rootPath,
    ...(options?.candidatePaths === undefined ? {} : { candidatePaths: options.candidatePaths }),
    ...(options?.excludePaths?.length ? { excludePaths: options.excludePaths } : {}),
    ...(options?.maxResults === undefined ? {} : { maxResults: options.maxResults }),
    ...(options?.searchQuery === undefined ? {} : { searchQuery: options.searchQuery }),
    ...(options?.includeIgnored === undefined ? {} : { includeIgnored: options.includeIgnored }),
    ...(options?.followSymlinks === undefined ? {} : { followSymlinks: options.followSymlinks })
  }
}
