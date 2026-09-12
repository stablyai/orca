import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const DiffNoteCreateSchema = z.object({
  worktree: z.string(),
  filePath: z.string(),
  lineNumber: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  body: z.string().min(1),
  rationale: z.string().optional(),
  authorName: z.string().optional(),
  scope: z.enum(['unstaged', 'staged', 'branch']).optional()
})

const DiffNoteListSchema = z.object({
  worktree: z.string(),
  filePath: z.string().optional()
})

const DiffNoteDeleteSchema = z.object({
  worktree: z.string(),
  commentId: z.string()
})

export const DIFF_NOTE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'diffNote.create',
    params: DiffNoteCreateSchema,
    handler: (params, { runtime }) => runtime.createAgentDiffNote(params)
  }),
  defineMethod({
    name: 'diffNote.list',
    params: DiffNoteListSchema,
    handler: (params, { runtime }) => runtime.listAgentDiffNotes(params)
  }),
  defineMethod({
    name: 'diffNote.delete',
    params: DiffNoteDeleteSchema,
    handler: (params, { runtime }) => runtime.deleteAgentDiffNote(params)
  })
]
