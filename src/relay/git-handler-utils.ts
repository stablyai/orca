/**
 * Pure parsing helpers extracted from git-handler.ts.
 *
 * Why: oxlint max-lines requires files to stay under 300 lines.
 * These functions have no side-effects and depend only on their arguments,
 * making them easy to test independently.
 */
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { isBinaryBuffer } from '../shared/binary-buffer'
import type { GitLineStats } from '../shared/git-uncommitted-line-stats'

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

export function parseConflictKind(xy: string): string | null {
  switch (xy) {
    case 'UU':
      return 'both_modified'
    case 'AA':
      return 'both_added'
    case 'DD':
      return 'both_deleted'
    case 'AU':
      return 'added_by_us'
    case 'UA':
      return 'added_by_them'
    case 'DU':
      return 'deleted_by_us'
    case 'UD':
      return 'deleted_by_them'
    default:
      return null
  }
}

/**
 * Parse a single unmerged entry line from porcelain v2 output.
 * Returns null if the entry should be skipped (e.g. submodule conflicts).
 */
export function parseUnmergedEntry(
  worktreePath: string,
  line: string
): Record<string, unknown> | null {
  const parts = line.split(' ')
  const xy = parts[1]
  const modeStage1 = parts[3]
  const modeStage2 = parts[4]
  const modeStage3 = parts[5]
  const filePath = parts.slice(10).join(' ')
  if (!filePath) {
    return null
  }

  // Skip submodule conflicts (mode 160000)
  if ([modeStage1, modeStage2, modeStage3].some((m) => m === '160000')) {
    return null
  }

  const conflictKind = parseConflictKind(xy)
  if (!conflictKind) {
    return null
  }

  let status: string = 'modified'
  if (conflictKind === 'both_deleted') {
    status = 'deleted'
  } else if (conflictKind !== 'both_modified' && conflictKind !== 'both_added') {
    try {
      status = existsSync(path.join(worktreePath, filePath)) ? 'modified' : 'deleted'
    } catch {
      // Why: defaulting to 'modified' on fs error is the least misleading option
      status = 'modified'
    }
  }

  return {
    path: filePath,
    area: 'unstaged',
    status,
    conflictKind,
    conflictStatus: 'unresolved'
  }
}

// ─── Branch diff parsing ─────────────────────────────────────────────

/**
 * Parse `git diff --name-status` output into structured change entries.
 */
export function parseBranchDiff(
  stdout: string,
  statsByPath: Map<string, GitLineStats> = new Map()
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

// ─── Worktree parsing ────────────────────────────────────────────────

function getErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const parts: string[] = []
    if ('message' in error && typeof error.message === 'string') {
      parts.push(error.message)
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      parts.push(error.stderr)
    }
    return parts.join('\n')
  }
  return String(error)
}

export function isUnsupportedWorktreeListZError(error: unknown): boolean {
  return /(?:unknown|invalid) (?:switch|option).*`?-z'?|(?:unknown|invalid) (?:switch|option).*`?z'?/i.test(
    getErrorText(error)
  )
}

export function parseWorktreeList(
  output: string,
  options: { nulDelimited?: boolean } = {}
): Record<string, unknown>[] {
  const worktrees: Record<string, unknown>[] = []
  const blocks = options.nulDelimited ? splitNulWorktreeList(output) : splitLineWorktreeList(output)

  for (const lines of blocks) {
    if (lines.length === 0) {
      continue
    }
    let wtPath = ''
    let head = ''
    let branch = ''
    let isBare = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        isBare = true
      }
    }

    if (wtPath) {
      worktrees.push({
        path: wtPath,
        head,
        branch,
        isBare,
        isMainWorktree: worktrees.length === 0
      })
    }
  }
  return worktrees
}

function splitLineWorktreeList(output: string): string[][] {
  return output
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim().split(/\r?\n/))
}

function splitNulWorktreeList(output: string): string[][] {
  if (!output.includes('\0')) {
    return splitLineWorktreeList(output)
  }

  const blocks: string[][] = []
  let currentBlock: string[] = []

  for (const field of output.split('\0')) {
    if (field) {
      currentBlock.push(field)
      continue
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock)
      currentBlock = []
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock)
  }

  return blocks
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
