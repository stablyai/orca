import { buildImageDataUri } from '../../../src/shared/image-data-uri'
import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { buildMobileDiffLines, type MobileDiffLine } from '../session/mobile-diff-lines'
import { mobileDiffImageDataUri } from './mobile-diff-image-preview'
import {
  fileTabDiffRead,
  fileTabImageRead,
  fileTabTextRead,
  type MobileFileTabDocRpcSender
} from './mobile-file-tab-doc-operations'

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
  client: MobileFileTabDocRpcSender,
  request: MobileFileTabDocRequest
): Promise<MobileFileTabDoc> {
  const worktree = `id:${request.worktreeId}`
  const { relativePath } = request
  if (request.diffSource === 'staged' || request.diffSource === 'unstaged') {
    const reply = await fileTabDiffRead.request(client, {
      worktree,
      filePath: relativePath,
      staged: request.diffSource === 'staged'
    })
    const result = fileTabDiffRead.interpret(reply)
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
    const preview = await fileTabImageRead.request(client, { worktree, relativePath })
    const result = fileTabImageRead.interpret(preview)
    const dataUri = result.isImage ? buildImageDataUri(result.mimeType, result.content) : null
    if (!dataUri) {
      throw new Error('binary_file')
    }
    return { status: 'ready', kind: 'image', dataUri }
  }

  const reply = await fileTabTextRead.request(client, { worktree, relativePath })
  const result = fileTabTextRead.interpret(reply)
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
