import { MEDIA_FILE_MIME_TYPES } from '../../../src/shared/file-preview/media-mime-types'
import { compareFileNames } from '../../../src/shared/file-listing/file-name-sort'

export type MobileDirEntry = {
  name: string
  isDirectory: boolean
  isSymlink?: boolean
}

export type MobileFileKind = 'text' | 'binary'

export type TreeNode = {
  id: string
  name: string
  relativePath: string
  depth: number
  kind: 'directory' | MobileFileKind
  isSymlink?: boolean
  /** A folder too big for one page shows how many entries it has. */
  entryCount?: number
}

export type DirectoryState = {
  entries: MobileDirEntry[]
  loading?: boolean
  error?: string
  /** The folder's size as the host last listed it. */
  total?: number
  /** The host has entries after the last one here. */
  hasMore?: boolean
}

export type DirectoryCache = Record<string, DirectoryState | undefined>

export type InlineStatusNode = {
  id: string
  relativePath: string
  depth: number
  kind: 'loading' | 'error'
  message?: string
}

/** Ends a part-loaded folder: "Show more" in the tree, "Searched N of M" in filter results. */
export type FolderPagingNode = {
  id: string
  relativePath: string
  depth: number
  kind: 'more' | 'searched'
  loaded: number
  total: number
}

export type FileExplorerRow = TreeNode | InlineStatusNode | FolderPagingNode

/** Rows per "Show more"; a folder bigger than this shows its entry count. */
export const DIRECTORY_PAGE_SIZE = 500

const DESKTOP_EXCLUDED_NAMES = new Set(['.git', 'node_modules'])
const BINARY_EXTENSIONS = new Set([
  ...Object.keys(MEDIA_FILE_MIME_TYPES),
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
  '.zip'
])

export function flattenDirectoryCache(
  cache: DirectoryCache,
  expanded: ReadonlySet<string>
): FileExplorerRow[] {
  const rows: FileExplorerRow[] = []
  visitDirectory('', 0, cache, expanded, rows)
  return rows
}

function visitDirectory(
  relativePath: string,
  depth: number,
  cache: DirectoryCache,
  expanded: ReadonlySet<string>,
  rows: FileExplorerRow[]
): void {
  const state = getDirectoryCacheState(cache, relativePath)
  const entries = state?.entries ?? []
  const visibleEntries = entries
    .filter(shouldIncludeMobileFileExplorerEntry)
    .sort(compareDirectoryEntries)

  for (const entry of visibleEntries) {
    const childPath = joinRelativePath(relativePath, entry.name)
    rows.push(toTreeNode(entry, childPath, depth, cache))
    if (entry.isDirectory && expanded.has(childPath)) {
      const childState = getDirectoryCacheState(cache, childPath)
      if (childState?.loading) {
        rows.push({
          id: `loading:${childPath}`,
          relativePath: childPath,
          depth: depth + 1,
          kind: 'loading'
        })
      } else if (childState?.error) {
        rows.push({
          id: `error:${childPath}`,
          relativePath: childPath,
          depth: depth + 1,
          kind: 'error',
          message: childState.error
        })
      } else {
        visitDirectory(childPath, depth + 1, cache, expanded, rows)
      }
    }
  }
  const paging = folderPagingNode('more', relativePath, depth, state)
  if (paging) {
    rows.push(paging)
  }
}

function folderPagingNode(
  kind: FolderPagingNode['kind'],
  relativePath: string,
  depth: number,
  state: DirectoryState | undefined
): FolderPagingNode | null {
  if (!state?.hasMore) {
    return null
  }
  const loaded = state.entries.length
  return {
    id: `${kind}:${relativePath}`,
    relativePath,
    depth,
    kind,
    loaded,
    // A folder that changed between pages can report a total at or below what is shown.
    total: Math.max(state.total ?? 0, loaded + 1)
  }
}

/**
 * Rows whose name contains the query, across every folder loaded so far, with their parent folders.
 * A part-loaded folder always shows, ending in a row that says how much of it was searched.
 */
export function filterDirectoryCache(cache: DirectoryCache, query: string): FileExplorerRow[] {
  const needle = query.trim().toLowerCase()
  const rows: FileExplorerRow[] = []
  if (needle !== '') {
    collectMatches('', 0, cache, needle, rows)
  }
  return rows
}

function collectMatches(
  relativePath: string,
  depth: number,
  cache: DirectoryCache,
  needle: string,
  rows: FileExplorerRow[]
): boolean {
  const state = getDirectoryCacheState(cache, relativePath)
  const entries = (state?.entries ?? [])
    .filter(shouldIncludeMobileFileExplorerEntry)
    .sort(compareDirectoryEntries)
  let matched = false
  for (const entry of entries) {
    const childPath = joinRelativePath(relativePath, entry.name)
    const nameMatches = entry.name.toLowerCase().includes(needle)
    const childRows: FileExplorerRow[] = []
    const childMatches =
      entry.isDirectory && collectMatches(childPath, depth + 1, cache, needle, childRows)
    if (nameMatches || childMatches) {
      rows.push(toTreeNode(entry, childPath, depth, cache), ...childRows)
      matched = true
    }
  }
  const searched = folderPagingNode('searched', relativePath, depth, state)
  if (searched) {
    rows.push(searched)
  }
  return matched || searched !== null
}

function toTreeNode(
  entry: MobileDirEntry,
  relativePath: string,
  depth: number,
  cache: DirectoryCache
): TreeNode {
  const total = entry.isDirectory ? getDirectoryCacheState(cache, relativePath)?.total : undefined
  return {
    id: `${entry.isDirectory ? 'dir' : 'file'}:${relativePath}`,
    name: entry.name,
    relativePath,
    depth,
    kind: entry.isDirectory ? 'directory' : getMobileFileKind(relativePath),
    isSymlink: entry.isSymlink,
    ...(total !== undefined && total > DIRECTORY_PAGE_SIZE ? { entryCount: total } : {})
  }
}

function compareDirectoryEntries(a: MobileDirEntry, b: MobileDirEntry): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1
  }
  return compareFileNames(a.name, b.name)
}

export function shouldIncludeMobileFileExplorerEntry(entry: MobileDirEntry): boolean {
  return !DESKTOP_EXCLUDED_NAMES.has(entry.name)
}

export function getDirectoryCacheState(
  cache: DirectoryCache,
  relativePath: string
): DirectoryState | undefined {
  // Inherited keys such as constructor must not masquerade as cached directories.
  return Object.hasOwn(cache, relativePath) ? cache[relativePath] : undefined
}

export function joinRelativePath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name
}

export function getMobileFileKind(relativePath: string): MobileFileKind {
  const basename = relativePath.split('/').pop() ?? relativePath
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return 'text'
  }
  return BINARY_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase()) ? 'binary' : 'text'
}

export function isMarkdownPath(relativePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(relativePath)
}
