// Pure tree projection for the mobile file explorer. Mobile mirrors desktop
// browse semantics by flattening cached files.readDir results as folders open.

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
  return a.name.localeCompare(b.name)
}

export function shouldIncludeMobileFileExplorerEntry(entry: MobileDirEntry): boolean {
  return !DESKTOP_EXCLUDED_NAMES.has(entry.name)
}

export function getDirectoryCacheState(
  cache: DirectoryCache,
  relativePath: string
): DirectoryState | undefined {
  // Why: repository paths are arbitrary object keys; inherited keys like
  // "constructor" must not masquerade as loaded directory state.
  return Object.prototype.hasOwnProperty.call(cache, relativePath) ? cache[relativePath] : undefined
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
