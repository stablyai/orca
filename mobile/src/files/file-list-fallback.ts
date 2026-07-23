// Fallback for desktops that predate files.readDir in the mobile RPC
// allowlist: synthesize the lazy directory cache from the flat, capped
// files.list result so the Files tab stays browsable against old desktops.
import { getUtf8ByteLengthForCodePoint } from '../../../src/shared/utf8-byte-limits'
import type { DirectoryCache, MobileDirEntry } from './file-tree'

// Why: each flat legacy path can amplify into many retained ancestor records.
export const LEGACY_MOBILE_FILE_LIST_MAX_FILES = 5_000
export const LEGACY_MOBILE_FILE_PATH_MAX_BYTES = 16 * 1024
export const LEGACY_MOBILE_FILE_PATH_MAX_DEPTH = 256
export const LEGACY_MOBILE_FILE_CACHE_MAX_DIRECTORIES = 16_384
export const LEGACY_MOBILE_FILE_CACHE_MAX_ENTRIES = 20_000
export const LEGACY_MOBILE_FILE_CACHE_MAX_RETAINED_BYTES = 16 * 1024 * 1024
export const LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE =
  'This legacy file list is too large to show safely on mobile. Update Orca Desktop to browse it folder by folder.'

const DIRECTORY_RETAINED_BYTES = 64
const ENTRY_RETAINED_BYTES = 64

export type LegacyMobileFileEntry = {
  relativePath: string
  basename: string
  kind: 'text' | 'binary'
}

export type LegacyFilesListResult = {
  files: LegacyMobileFileEntry[]
  totalCount: number
  truncated: boolean
}

type LegacyFileCacheBuildState = {
  childrenByDir: Map<string, Map<string, MobileDirEntry>>
  directories: number
  entries: number
  retainedBytes: number
}

// Same detection shape as isMobileGitUnavailable in mobile-git-status.ts:
// 'forbidden' = method exists but is not mobile-allowlisted on the old
// desktop; 'method_not_found' = desktop predates the method entirely.
export function isMobileMethodUnavailableError(
  code: string | undefined,
  message: string | undefined
): boolean {
  return (
    code === 'forbidden' ||
    code === 'method_not_found' ||
    message?.includes('not available to mobile clients') === true
  )
}

export function directoryCacheFromFileList(files: unknown): DirectoryCache {
  if (!Array.isArray(files)) {
    throw new Error('Desktop returned an invalid legacy file list.')
  }
  if (files.length > LEGACY_MOBILE_FILE_LIST_MAX_FILES) {
    throwLegacyFileListLimitError()
  }

  const state: LegacyFileCacheBuildState = {
    childrenByDir: new Map(),
    directories: 0,
    entries: 0,
    retainedBytes: 0
  }
  ensureDirectory(state, '')
  for (const file of files) {
    const relativePath = getLegacyRelativePath(file)
    if (relativePath === null) {
      throw new Error('Desktop returned an invalid legacy file list.')
    }
    addFilePath(state, relativePath, measureBoundedPathDepth(relativePath))
  }
  return createDirectoryCache(state.childrenByDir)
}

function getLegacyRelativePath(value: unknown): string | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const relativePath = (value as { relativePath?: unknown }).relativePath
  return typeof relativePath === 'string' ? relativePath : null
}

function measureBoundedPathDepth(relativePath: string): number {
  let bytes = 0
  let depth = 0
  let insideSegment = false
  for (let index = 0; index < relativePath.length; index += 1) {
    const codePoint = relativePath.codePointAt(index) ?? 0
    bytes += getUtf8ByteLengthForCodePoint(codePoint)
    if (bytes > LEGACY_MOBILE_FILE_PATH_MAX_BYTES) {
      throwLegacyFileListLimitError()
    }
    if (codePoint === 47) {
      if (insideSegment) {
        depth += 1
        assertPathDepth(depth)
      }
      insideSegment = false
    } else {
      insideSegment = true
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  if (insideSegment) {
    depth += 1
    assertPathDepth(depth)
  }
  return depth
}

function assertPathDepth(depth: number): void {
  if (depth > LEGACY_MOBILE_FILE_PATH_MAX_DEPTH) {
    throwLegacyFileListLimitError()
  }
}

function addFilePath(state: LegacyFileCacheBuildState, relativePath: string, depth: number): void {
  let parentPath = ''
  let segmentStart = 0
  let segmentIndex = 0
  for (let cursor = 0; cursor <= relativePath.length; cursor += 1) {
    if (cursor < relativePath.length && relativePath.charCodeAt(cursor) !== 47) {
      continue
    }
    if (cursor > segmentStart) {
      segmentIndex += 1
      const name = relativePath.slice(segmentStart, cursor)
      const isDirectory = segmentIndex < depth
      addDirectoryEntry(state, parentPath, name, isDirectory)
      if (isDirectory) {
        parentPath = parentPath ? `${parentPath}/${name}` : name
        ensureDirectory(state, parentPath)
      }
    }
    segmentStart = cursor + 1
  }
}

function ensureDirectory(state: LegacyFileCacheBuildState, path: string): void {
  if (state.childrenByDir.has(path)) {
    return
  }
  const retainedBytes = path.length * 2 + DIRECTORY_RETAINED_BYTES
  if (
    state.directories >= LEGACY_MOBILE_FILE_CACHE_MAX_DIRECTORIES ||
    state.retainedBytes > LEGACY_MOBILE_FILE_CACHE_MAX_RETAINED_BYTES - retainedBytes
  ) {
    throwLegacyFileListLimitError()
  }
  state.childrenByDir.set(path, new Map())
  state.directories += 1
  state.retainedBytes += retainedBytes
}

function addDirectoryEntry(
  state: LegacyFileCacheBuildState,
  parentPath: string,
  name: string,
  isDirectory: boolean
): void {
  const children = state.childrenByDir.get(parentPath)
  if (!children) {
    throw new Error('Legacy file cache builder lost its parent directory.')
  }
  const existing = children.get(name)
  if (existing) {
    existing.isDirectory ||= isDirectory
    return
  }
  const retainedBytes = name.length * 2 + ENTRY_RETAINED_BYTES
  if (
    state.entries >= LEGACY_MOBILE_FILE_CACHE_MAX_ENTRIES ||
    state.retainedBytes > LEGACY_MOBILE_FILE_CACHE_MAX_RETAINED_BYTES - retainedBytes
  ) {
    throwLegacyFileListLimitError()
  }
  children.set(name, { name, isDirectory })
  state.entries += 1
  state.retainedBytes += retainedBytes
}

function createDirectoryCache(
  childrenByDir: ReadonlyMap<string, ReadonlyMap<string, MobileDirEntry>>
): DirectoryCache {
  const cache: DirectoryCache = {}
  for (const [path, children] of childrenByDir) {
    // Why: assignment to a '__proto__' path would invoke its legacy setter.
    Object.defineProperty(cache, path, {
      configurable: true,
      enumerable: true,
      value: { entries: Array.from(children.values()) },
      writable: true
    })
  }
  return cache
}

function throwLegacyFileListLimitError(): never {
  throw new Error(LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE)
}
