import * as path from 'node:path'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import { getLargeDiffRenderLimit } from '../../../shared/large-diff-render-limit'
import { PREVIEWABLE_BINARY_MIME_TYPES } from './previewable-binary-mime-types'

export function buildDiffResult(
  originalContent: string,
  modifiedContent: string,
  originalIsBinary: boolean,
  modifiedIsBinary: boolean,
  filePath?: string,
  /** A side was over the read cap rather than proven binary. */
  tooLarge = false
): GitDiffResult {
  if (originalIsBinary || modifiedIsBinary) {
    const mimeType = filePath
      ? PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
      : undefined
    const sides = originalIsBinary
      ? { originalIsBinary: true as const, modifiedIsBinary }
      : { originalIsBinary: false, modifiedIsBinary: true as const }
    return {
      kind: 'binary',
      originalContent,
      modifiedContent,
      ...sides,
      // Why: renderer still checks legacy `isImage` before previewing, so set it for PDFs too until the contract is renamed.
      ...(mimeType ? { isImage: true, mimeType } : {}),
      ...(tooLarge ? { tooLarge: true } : {})
    }
  }

  // Why: over the render limit, return metadata instead of huge text so the renderer can show fallback UI.
  const largeDiffRenderLimit = getLargeDiffRenderLimit({ originalContent, modifiedContent })
  if (largeDiffRenderLimit.limited) {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false,
      largeDiffRenderLimit
    }
  }

  return {
    kind: 'text',
    originalContent,
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}
