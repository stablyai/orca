import type { DiffComment, DiffReviewScope } from '../../shared/diff-comment-types'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getFileWorktreeSelector, resolveFilePath } from './file'

const DIFF_NOTE_SCOPES: readonly DiffReviewScope[] = ['unstaged', 'staged', 'branch']

function getRequiredLine(flags: Map<string, string | boolean>): number {
  const line = getOptionalPositiveIntegerFlag(flags, 'line')
  if (line === undefined) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --line')
  }
  return line
}

function getOptionalScope(flags: Map<string, string | boolean>): DiffReviewScope | undefined {
  const scope = getOptionalStringFlag(flags, 'scope')
  if (scope === undefined) {
    return undefined
  }
  if (!DIFF_NOTE_SCOPES.includes(scope as DiffReviewScope)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid --scope. Use unstaged, staged, or branch.'
    )
  }
  return scope as DiffReviewScope
}

function formatDiffNote(note: DiffComment): string {
  const lines = [`Agent note ${note.id}`, `File: ${note.filePath}`, `Line: ${note.lineNumber}`]
  if (note.startLine !== undefined && note.startLine !== note.lineNumber) {
    lines[2] = `Lines: ${note.startLine}-${note.lineNumber}`
  }
  lines.push(`Note: "${note.body}"`)
  if (note.rationale) {
    lines.push(`Rationale: "${note.rationale}"`)
  }
  return lines.join('\n')
}

function formatDiffNoteList(result: { comments: DiffComment[] }): string {
  if (result.comments.length === 0) {
    return 'No agent notes.'
  }
  return result.comments
    .map((note) => `${note.id}  ${note.filePath}:${note.lineNumber}  ${note.body}`)
    .join('\n')
}

export const DIFF_NOTE_HANDLERS: Record<string, CommandHandler> = {
  'diff-note create': async (ctx) => {
    const worktree = await getFileWorktreeSelector(ctx)
    const path = getRequiredStringFlag(ctx.flags, 'path')
    const line = getRequiredLine(ctx.flags)
    const body = getRequiredStringFlag(ctx.flags, 'body')
    const startLine = getOptionalPositiveIntegerFlag(ctx.flags, 'start-line')
    const rationale = getOptionalStringFlag(ctx.flags, 'rationale')
    const authorName = getOptionalStringFlag(ctx.flags, 'author')
    const scope = getOptionalScope(ctx.flags)

    const filePath = await resolveFilePath(ctx, worktree, path)
    const result = await ctx.client.call<DiffComment>('diffNote.create', {
      worktree,
      filePath,
      lineNumber: line,
      startLine,
      body,
      rationale,
      authorName,
      scope
    })
    printResult(result, ctx.json, formatDiffNote)
  },

  'diff-note list': async (ctx) => {
    const worktree = await getFileWorktreeSelector(ctx)
    const filePath = getOptionalStringFlag(ctx.flags, 'path')
    const result = await ctx.client.call<{ comments: DiffComment[] }>('diffNote.list', {
      worktree,
      filePath
    })
    printResult(result, ctx.json, formatDiffNoteList)
  },

  'diff-note rm': async (ctx) => {
    const worktree = await getFileWorktreeSelector(ctx)
    const commentId = getRequiredStringFlag(ctx.flags, 'id')
    const result = await ctx.client.call<{ deleted: boolean }>('diffNote.delete', {
      worktree,
      commentId
    })
    printResult(result, ctx.json, (res) =>
      res.deleted ? `Deleted note ${commentId}` : `No note found with id ${commentId}`
    )
  }
}
