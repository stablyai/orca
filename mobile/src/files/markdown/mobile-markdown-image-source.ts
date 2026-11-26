import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../../src/shared/file-access/cross-platform-path'
import { routeMarkdownHref } from '../../components/markdown/links/markdown-href-routing'
import type { MobileFilePreviewRpcSender } from '../preview/mobile-file-preview-operations'
import { loadMobileFilePreview } from '../preview/mobile-file-preview-request'
import { classifyMobileArtifact } from '../preview/mobile-artifact-kind'
import { svgMarkupDataUri } from '../../../../src/shared/file-preview/svg-document'
import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { translate } from '../../i18n/mobile-i18n'

const readRemoteImage = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'linkPreview.image-or-skip',
    method: 'linkPreview.image',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'link-preview-image',
      z.object({
        dataUri: z
          .string()
          .regex(/^data:image\/[a-z0-9.+-]+;base64,/i)
          .nullable()
      })
    )
  })
)

// Absolute paths leave the workspace; an external-file tab's document has no workspace images.
function isOutsideWorkspace(path: string): boolean {
  return /^[\\/]/.test(path) || isWindowsAbsolutePathLike(path) || path.includes('\0')
}

export async function loadMarkdownPreviewImage(
  client: MobileFilePreviewRpcSender | null,
  worktreeId: string,
  documentPath: string,
  href: string
): Promise<string> {
  if (/^https?:\/\//i.test(href)) {
    if (!client) {
      throw new Error('Waiting for host…')
    }
    const result = readRemoteImage.interpret(await readRemoteImage.request(client, { url: href }))
    if (result.accepted && result.value.dataUri) {
      return result.value.dataUri
    }
    throw new Error(translate('files.markdownPreviewImage.loadFailed', 'Unable to load image'))
  }
  const link = routeMarkdownHref(href)
  if (link.kind !== 'file') {
    throw new Error('Unsupported image location')
  }
  const path = link.pathText
  if (isOutsideWorkspace(path) || isOutsideWorkspace(documentPath)) {
    throw new Error('Image must be inside this workspace')
  }
  const source = documentPath.replaceAll('\\', '/')
  const directory = source.slice(0, source.lastIndexOf('/') + 1)
  const relativePath = relativePathInsideRoot(
    '/workspace',
    resolveRuntimePath(`/workspace/${directory}`, path)
  )
  const artifactKind = relativePath ? classifyMobileArtifact(relativePath) : null
  if (!relativePath || (artifactKind !== 'image' && artifactKind !== 'vector')) {
    throw new Error('Unsupported image location')
  }
  if (!client) {
    throw new Error('Waiting for host…')
  }
  const result = await loadMobileFilePreview(client, worktreeId, relativePath)
  if (result.status === 'ready' && result.kind === 'image') {
    return result.dataUri
  }
  if (result.status === 'ready' && result.kind === 'svg' && !result.truncated) {
    return svgMarkupDataUri(result.content)
  }
  throw new Error('message' in result ? result.message : 'Unable to load image')
}
