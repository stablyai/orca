import type { DiffComment, DiffReviewScope } from '../../../src/shared/types'

export type CreateMobileDiffCommentInput = {
  worktreeId: string
  filePath: string
  oldPath?: string
  lineNumber: number
  body: string
  id: string
  createdAt: number
  scope?: DiffReviewScope
  diffIdentity?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMarkdownComment(comment: Pick<DiffComment, 'source'>): boolean {
  return comment.source === 'markdown'
}

function normalizeScope(value: unknown): DiffReviewScope | undefined {
  return value === 'unstaged' || value === 'staged' || value === 'branch' ? value : undefined
}

// Why: mobile Vitest/Metro run from the mobile package and cannot transform
// runtime imports from root src/shared. Keep this byte-for-byte compatible with
// the desktop shared formatter contract.
export function formatDiffComment(c: DiffComment): string {
  const escaped = c.body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  const locationLabel =
    c.lineNumber === 0
      ? 'Scope: file'
      : c.startLine !== undefined && c.startLine !== c.lineNumber
        ? `Lines: ${c.startLine}-${c.lineNumber}`
        : `Line: ${c.lineNumber}`
  if (!isMarkdownComment(c)) {
    return [`File: ${c.filePath}`, locationLabel, `User comment: "${escaped}"`].join('\n')
  }
  return [
    `File: ${c.filePath}`,
    'Source: markdown',
    locationLabel,
    `User comment: "${escaped}"`
  ].join('\n')
}

export function formatDiffComments(comments: readonly DiffComment[]): string {
  return comments.map(formatDiffComment).join('\n\n')
}

export function formatMobileDiffReviewPrompt(comments: readonly DiffComment[]): string {
  return [
    'You are reviewing the current worktree. Address the following mobile review notes.',
    '',
    formatDiffComments(comments),
    '',
    'After applying fixes:',
    '1. Summarize changed files.',
    '2. Run relevant tests.',
    '3. Tell me if anything remains risky.'
  ].join('\n')
}

export function normalizeMobileDiffComments(value: unknown, worktreeId: string): DiffComment[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((candidate): DiffComment[] => {
    if (!isRecord(candidate)) {
      return []
    }
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    const filePath = typeof candidate.filePath === 'string' ? candidate.filePath : ''
    const lineNumber = typeof candidate.lineNumber === 'number' ? candidate.lineNumber : Number.NaN
    const body = typeof candidate.body === 'string' ? candidate.body.trim() : ''
    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now()
    if (!id || !filePath || !Number.isFinite(lineNumber) || lineNumber < 0 || !body) {
      return []
    }
    return [
      {
        id,
        worktreeId: typeof candidate.worktreeId === 'string' ? candidate.worktreeId : worktreeId,
        filePath,
        source: candidate.source === 'markdown' ? 'markdown' : 'diff',
        selectedText:
          typeof candidate.selectedText === 'string' ? candidate.selectedText : undefined,
        startLine: typeof candidate.startLine === 'number' ? candidate.startLine : undefined,
        lineNumber,
        body,
        createdAt,
        updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : undefined,
        sentAt: typeof candidate.sentAt === 'number' ? candidate.sentAt : undefined,
        scope: normalizeScope(candidate.scope),
        oldPath: typeof candidate.oldPath === 'string' ? candidate.oldPath : undefined,
        diffIdentity:
          typeof candidate.diffIdentity === 'string' ? candidate.diffIdentity : undefined,
        side: 'modified'
      }
    ]
  })
}

export function createMobileDiffComment(input: CreateMobileDiffCommentInput): DiffComment | null {
  const body = input.body.trim()
  if (!body || !Number.isFinite(input.lineNumber) || input.lineNumber < 0) {
    return null
  }
  return {
    id: input.id,
    worktreeId: input.worktreeId,
    filePath: input.filePath,
    oldPath: input.oldPath,
    source: 'diff',
    lineNumber: input.lineNumber,
    body,
    createdAt: input.createdAt,
    scope: input.scope,
    diffIdentity: input.diffIdentity,
    side: 'modified'
  }
}

export function addMobileDiffComment(
  comments: readonly DiffComment[],
  input: CreateMobileDiffCommentInput
): { comments: DiffComment[]; comment: DiffComment | null } {
  const comment = createMobileDiffComment(input)
  if (!comment) {
    return { comments: [...comments], comment: null }
  }
  return { comments: [...comments, comment], comment }
}

export function removeMobileDiffComments(
  comments: readonly DiffComment[],
  ids: ReadonlySet<string>
): DiffComment[] {
  if (ids.size === 0) {
    return [...comments]
  }
  return comments.filter((comment) => !ids.has(comment.id))
}

function deliveredCommentMatches(comment: DiffComment, delivered: DiffComment): boolean {
  return (
    comment.id === delivered.id &&
    comment.body === delivered.body &&
    comment.filePath === delivered.filePath &&
    comment.lineNumber === delivered.lineNumber &&
    comment.selectedText === delivered.selectedText &&
    comment.source === delivered.source &&
    comment.startLine === delivered.startLine
  )
}

export function removeDeliveredMobileDiffComments(
  comments: readonly DiffComment[],
  delivered: readonly DiffComment[]
): DiffComment[] {
  if (delivered.length === 0) {
    return [...comments]
  }
  const deliveredById = new Map(delivered.map((comment) => [comment.id, comment]))
  return comments.filter((comment) => {
    const snapshot = deliveredById.get(comment.id)
    return !snapshot || !deliveredCommentMatches(comment, snapshot)
  })
}
