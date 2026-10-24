import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../src/shared/cross-platform-path'
import { routeMarkdownHref } from '../components/markdown-href-routing'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { loadMobileFilePreview } from './mobile-file-preview-request'
import { classifyMobileArtifact } from '../session/mobile-artifact-kind'

export async function loadMarkdownPreviewImage(
  client: MobileFilePreviewRpcSender | null,
  worktreeId: string,
  documentPath: string,
  href: string
): Promise<string> {
  if (/^https?:\/\//i.test(href)) {
    return href
  }
  const link = routeMarkdownHref(href)
  if (link.kind !== 'file') {
    throw new Error('Unsupported image location')
  }
  const path = link.pathText
  if (/^[\\/]/.test(path) || isWindowsAbsolutePathLike(path) || path.includes('\0')) {
    throw new Error('Image must be inside this workspace')
  }
  const source = documentPath.replaceAll('\\', '/')
  const directory = source.slice(0, source.lastIndexOf('/') + 1)
  const relativePath = relativePathInsideRoot(
    '/workspace',
    resolveRuntimePath(`/workspace/${directory}`, path)
  )
  if (!relativePath || classifyMobileArtifact(relativePath) !== 'image') {
    throw new Error('Unsupported image location')
  }
  if (!client) {
    throw new Error('Waiting for desktop...')
  }
  const result = await loadMobileFilePreview(client, worktreeId, relativePath)
  if (result.status === 'ready' && result.kind === 'image') {
    return result.dataUri
  }
  throw new Error('message' in result ? result.message : 'Unable to load image')
}
