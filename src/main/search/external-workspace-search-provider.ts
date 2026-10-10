import type { SearchOptions, SearchResult } from '../../shared/code-search-types'

// A local index (a daemon, a native addon) that may answer workspace searches before ripgrep.
// Every query method resolves null to let the bundled ripgrep path answer instead, so a
// provider can decline anything it cannot serve exactly: unsupported options, a miss, an error.

export type ExternalFileListRequest = {
  /** Authorized absolute root on this machine; never a WSL or remote path. */
  rootPath: string
  excludePathPrefixes: readonly string[]
  includeIgnored: boolean
  followSymlinks: boolean
  candidatePaths?: readonly string[]
  maxResults?: number
  maxSerializedBytes?: number
  pathFilter?: (relativePath: string) => boolean
  signal?: AbortSignal
}

export type ExternalFilePathSearchRequest = {
  rootPath: string
  excludePathPrefixes: readonly string[]
  includeIgnored: boolean
  followSymlinks: boolean
  query: string
  limit: number
  signal?: AbortSignal
}

export type ExternalFilePathSearchResult = {
  paths: string[]
  totalCount: number
  truncated: boolean
}

export type ExternalTextSearchRequest = {
  options: SearchOptions
  rootPath: string
  /** Root the caller reports results under (it may differ from the authorized root's spelling). */
  resultRootPath: string
  signal?: AbortSignal
}

export type ExternalRankedPathSearchQuery = {
  rootPath: string
  includeIgnored: boolean
  followSymlinks: boolean
}

export type ExternalWorkspaceSearchProvider = {
  listFiles(request: ExternalFileListRequest): Promise<string[] | null>
  searchFilePaths(
    request: ExternalFilePathSearchRequest
  ): Promise<ExternalFilePathSearchResult | null>
  searchText(request: ExternalTextSearchRequest): Promise<SearchResult | null>
  /** True when ranked per-query path search for this root is cheaper than listing every path. */
  supportsRankedPathSearch(query: ExternalRankedPathSearchQuery): Promise<boolean>
}

let provider: ExternalWorkspaceSearchProvider | null = null

export function setExternalWorkspaceSearchProvider(
  next: ExternalWorkspaceSearchProvider | null
): void {
  provider = next
}

export function getExternalWorkspaceSearchProvider(): ExternalWorkspaceSearchProvider | null {
  return provider
}

/** A quick-open root as the listing and path search resolve it; WSL roots carry their distro. */
export type ExternalSearchRoot = {
  authorizedRootPath: string
  excludePathPrefixes: readonly string[]
  wslDistroForOutput?: string
}

type QuickOpenScanOptions = { includeIgnored?: boolean; followSymlinks?: boolean }

// Why: the index runs on this machine and sees its paths, so WSL and remote roots keep ripgrep.
export async function listFilesFromExternalIndex(
  root: ExternalSearchRoot,
  request: QuickOpenScanOptions &
    Omit<ExternalFileListRequest, 'rootPath' | 'excludePathPrefixes' | keyof QuickOpenScanOptions>
): Promise<string[] | null> {
  if (!provider || root.wslDistroForOutput) {
    return null
  }
  return provider.listFiles({
    ...request,
    rootPath: root.authorizedRootPath,
    excludePathPrefixes: root.excludePathPrefixes,
    includeIgnored: request.includeIgnored !== false,
    followSymlinks: request.followSymlinks === true
  })
}

export async function searchFilePathsFromExternalIndex(
  root: ExternalSearchRoot,
  request: QuickOpenScanOptions & { query: string; limit: number; signal?: AbortSignal }
): Promise<ExternalFilePathSearchResult | null> {
  if (!provider || root.wslDistroForOutput) {
    return null
  }
  return provider.searchFilePaths({
    rootPath: root.authorizedRootPath,
    excludePathPrefixes: root.excludePathPrefixes,
    includeIgnored: request.includeIgnored !== false,
    followSymlinks: request.followSymlinks === true,
    query: request.query,
    limit: request.limit,
    signal: request.signal
  })
}

export async function searchTextFromExternalIndex(
  request: ExternalTextSearchRequest & { wslDistro?: string; wslDistroForOutput?: string }
): Promise<SearchResult | null> {
  if (!provider || request.wslDistro || request.wslDistroForOutput) {
    return null
  }
  const { options, rootPath, resultRootPath, signal } = request
  return provider.searchText({ options, rootPath, resultRootPath, signal })
}
