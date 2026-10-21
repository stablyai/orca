import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../src/shared/cross-platform-path'
import { splitFilePathLineSuffix } from '../components/markdown-file-path-detection'
import {
  createMobileFilePreviewHref,
  type MobileFilePreviewRouteParams
} from './mobile-file-preview-route'

export function mobileMarkdownFileLink(params: MobileFilePreviewRouteParams, pathText: string) {
  if (params.source === 'terminalArtifact' || !params.relativePath) {
    return null
  }
  const { path, line, column } = splitFilePathLineSuffix(pathText)
  if (!path || /^[\\/]/.test(path) || isWindowsAbsolutePathLike(path) || path.includes('\0')) {
    return null
  }
  // Resolve under a virtual root; the host still authorizes the actual workspace read.
  const root = '/workspace'
  const source = params.relativePath.replaceAll('\\', '/')
  const directory = source.slice(0, source.lastIndexOf('/') + 1)
  const target = resolveRuntimePath(`${root}/${directory}`, path)
  const relativePath = relativePathInsideRoot(root, target)
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
