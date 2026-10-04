/**
 * Pure parsing helpers extracted from git-handler.ts.
 *
 * Why: oxlint max-lines requires files to stay under 300 lines.
 * These functions have no side-effects and depend only on their arguments,
 * making them easy to test independently.
 */
import * as path from 'node:path'
import { isBinaryBuffer } from '../shared/binary-buffer'
export { isUnsupportedWorktreeListZError } from '../shared/git-worktree-command-capabilities'

// ─── Binary / blob helpers ───────────────────────────────────────────

export const PREVIEWABLE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

export function bufferToBlob(
  buffer: Buffer,
  filePath?: string
): { content: string; isBinary: boolean } {
  const binary = isBinaryBuffer(buffer)
  if (binary) {
    const ext = filePath ? path.extname(filePath).toLowerCase() : ''
    const previewable = !!PREVIEWABLE_MIME[ext]
    return { content: previewable ? buffer.toString('base64') : '', isBinary: true }
  }
  return { content: buffer.toString('utf-8'), isBinary: false }
}
