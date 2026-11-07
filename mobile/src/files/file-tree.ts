import { MEDIA_FILE_MIME_TYPES } from '../../../src/shared/media-file-extensions'
import { compareFileNames } from '../../../src/shared/file-name-sort'

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
}

export type DirectoryState = {
  entries: MobileDirEntry[]
  loading?: boolean
  error?: string
}

export type DirectoryCache = Record<string, DirectoryState | undefined>

export type InlineStatusNode = {
  id: string
  relativePath: string
  depth: number
  kind: 'loading' | 'error'
  message?: string
}

export type FileExplorerRow = TreeNode | InlineStatusNode

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
    rows.push(toTreeNode(entry, childPath, depth))
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
}

/** Rows whose name contains the query, across every folder loaded so far, with their parent folders. */
export function filterDirectoryCache(cache: DirectoryCache, query: string): TreeNode[] {
  const needle = query.trim().toLowerCase()
  const rows: TreeNode[] = []
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
  rows: TreeNode[]
): boolean {
  const entries = (getDirectoryCacheState(cache, relativePath)?.entries ?? [])
    .filter(shouldIncludeMobileFileExplorerEntry)
    .sort(compareDirectoryEntries)
  let matched = false
  for (const entry of entries) {
    const childPath = joinRelativePath(relativePath, entry.name)
    const nameMatches = entry.name.toLowerCase().includes(needle)
    const childRows: TreeNode[] = []
    const childMatches =
      entry.isDirectory && collectMatches(childPath, depth + 1, cache, needle, childRows)
    if (nameMatches || childMatches) {
      rows.push(toTreeNode(entry, childPath, depth), ...childRows)
      matched = true
    }
  }
  return matched
}

function toTreeNode(entry: MobileDirEntry, relativePath: string, depth: number): TreeNode {
  return {
    id: `${entry.isDirectory ? 'dir' : 'file'}:${relativePath}`,
    name: entry.name,
    relativePath,
    depth,
    kind: entry.isDirectory ? 'directory' : getMobileFileKind(relativePath),
    isSymlink: entry.isSymlink
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
