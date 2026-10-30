import {
  isCaseInsensitiveRuntimeRoot,
  isWindowsAbsolutePathLike,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../src/shared/cross-platform-path'
import { splitFilePathLineSuffix } from '../components/markdown-file-path-detection'
import {
  createMobileFilePreviewHref,
  type MobileFilePreviewRouteParams
} from './mobile-file-preview-route'

export function resolveMarkdownFilePath(
  documentPath: string,
  path: string,
  documentAbsolutePath?: string
): string | null {
  if (!path || path.includes('\0')) {
    return null
  }
  const source = documentPath.replaceAll('\\', '/')
  if (
    !source ||
    source.startsWith('/') ||
    isWindowsAbsolutePathLike(source) ||
    source.split('/').includes('..')
  ) {
    return null
  }
  let root = '/workspace'
  if (documentAbsolutePath) {
    const absolute = documentAbsolutePath.replaceAll('\\', '/')
    const tail = `/${source}`
    const matches = isCaseInsensitiveRuntimeRoot(documentAbsolutePath)
      ? absolute.toLowerCase().endsWith(tail.toLowerCase())
      : absolute.endsWith(tail)
    if (!matches) {
      return null
    }
    root = absolute.slice(0, -source.length)
  } else if (/^[\\/]/.test(path) || isWindowsAbsolutePathLike(path)) {
    return null
  }
  const directory = source.slice(0, source.lastIndexOf('/') + 1)
  return relativePathInsideRoot(root, resolveRuntimePath(resolveRuntimePath(root, directory), path))
}

export function mobileMarkdownFileLink(
  params: MobileFilePreviewRouteParams,
  pathText: string,
  documentAbsolutePath?: string
) {
  if (params.source === 'terminalArtifact' || !params.relativePath) {
    return null
  }
  const { path, line, column } = splitFilePathLineSuffix(pathText)
  const relativePath = resolveMarkdownFilePath(params.relativePath, path, documentAbsolutePath)
  if (!relativePath) {
    return null
  }
  return createMobileFilePreviewHref({
    hostId: params.hostId,
    worktreeId: params.worktreeId,
    worktreeName: params.worktreeName,
    source: 'worktree',
    relativePath,
    ...(line !== null ? { line: String(line) } : {}),
    ...(column !== null ? { column: String(column) } : {})
  })
}
