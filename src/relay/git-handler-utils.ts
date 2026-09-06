/**
 * Pure parsing helpers extracted from git-handler.ts.
 *
 * Why: oxlint max-lines requires files to stay under 300 lines.
 * These functions have no side-effects and depend only on their arguments,
 * making them easy to test independently.
 */
import * as path from 'node:path'
import { isBinaryBuffer } from '../shared/binary-buffer'
import type { GitLineStats } from '../shared/git-uncommitted-line-stats'
export { isUnsupportedWorktreeListZError } from '../shared/git-worktree-command-capabilities'

export function parseBranchStatusChar(char: string): string {
  switch (char) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

// ─── Branch diff parsing ─────────────────────────────────────────────

/**
 * Parse `git diff --name-status` output into structured change entries.
 */
export function parseBranchDiff(
  stdout: string,
  statsByPath = new Map<string, GitLineStats>()
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const parts = line.split('\t')
    const rawStatus = parts[0] ?? ''
    const status = parseBranchStatusChar(rawStatus[0] ?? 'M')

    if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
      const oldPath = parts[1]
      const filePath = parts[2]
      if (filePath) {
        entries.push({ path: filePath, oldPath, status, ...statsByPath.get(filePath) })
      }
    } else {
      const filePath = parts[1]
      if (filePath) {
        entries.push({ path: filePath, status, ...statsByPath.get(filePath) })
      }
    }
  }
  return entries
}

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
