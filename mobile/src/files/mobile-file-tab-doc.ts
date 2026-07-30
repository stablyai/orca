import { buildImageDataUri } from '../../../src/shared/image-data-uri'
import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { buildMobileDiffLines, type MobileDiffLine } from '../session/mobile-diff-lines'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { mobileDiffImageDataUri, type MobileBinaryDiffResult } from './mobile-diff-image-preview'

type FileTabDocClient = Pick<RpcClient, 'sendRequest'>

// The ready doc a session file tab renders. Mirrors the ready arm of the route's
// FileDocState; kept in src so the loader stays testable without the route.
export type MobileFileTabDoc =
  | { status: 'ready'; kind: 'file'; content: string; truncated: boolean; byteLength: number }
  | { status: 'ready'; kind: 'diff'; lines: MobileDiffLine[]; truncated: boolean }
  | { status: 'ready'; kind: 'image'; dataUri: string }
  | { status: 'ready'; kind: 'html'; content: string }

export type MobileFileTabDocRequest = {
  worktreeId: string
  relativePath: string
  diffSource?: 'staged' | 'unstaged' | 'branch' | 'commit'
}

// Throws 'binary_file'/'file_too_large'/the RPC error message; callers map those
// to error docs.
export async function resolveMobileFileTabDoc(
  client: FileTabDocClient,
  request: MobileFileTabDocRequest
): Promise<MobileFileTabDoc> {
  const worktree = `id:${request.worktreeId}`
  const { relativePath } = request
  if (request.diffSource === 'staged' || request.diffSource === 'unstaged') {
    const response = await client.sendRequest('git.diff', {
      worktree,
      filePath: relativePath,
      staged: request.diffSource === 'staged'
    })
    if (!response.ok) {
      throw new Error((response as RpcFailure).error.message)
    }
    const result = (response as RpcSuccess).result as
      | { kind: 'text'; originalContent: string; modifiedContent: string }
      | MobileBinaryDiffResult
    if (result.kind !== 'text') {
      // Render image diffs (add/modify/delete) from the base64 the host already
      // sends; only non-previewable binaries stay unavailable.
      const dataUri = mobileDiffImageDataUri(result)
      if (!dataUri) {
        throw new Error('binary_file')
      }
      return { status: 'ready', kind: 'image', dataUri }
    }
    const diff = buildMobileDiffLines(result.originalContent, result.modifiedContent)
    return { status: 'ready', kind: 'diff', lines: diff.lines, truncated: diff.truncated }
  }

  const artifactKind = classifyMobileArtifact(relativePath)
  if (artifactKind === 'image') {
    const preview = await client.sendRequest('files.readPreview', { worktree, relativePath })
    if (!preview.ok) {
      throw new Error((preview as RpcFailure).error.message)
    }
    const result = (preview as RpcSuccess).result as {
      content: string
      isImage?: boolean
      mimeType?: string
    }
    const dataUri = result.isImage ? buildImageDataUri(result.mimeType, result.content) : null
    if (!dataUri) {
      throw new Error('binary_file')
    }
    return { status: 'ready', kind: 'image', dataUri }
  }

  const response = await client.sendRequest('files.read', { worktree, relativePath })
  if (!response.ok) {
    throw new Error((response as RpcFailure).error.message)
  }
  const result = (response as RpcSuccess).result as {
    content: string
    truncated: boolean
    byteLength: number
  }
  if (artifactKind === 'html') {
    return { status: 'ready', kind: 'html', content: result.content }
  }
  return {
    status: 'ready',
    kind: 'file',
    content: result.content,
    truncated: result.truncated,
    byteLength: result.byteLength
  }
}
