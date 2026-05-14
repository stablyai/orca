import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const NoteScopedParams = z.object({
  worktree: requiredString('Missing worktree selector')
})

const NoteListParams = NoteScopedParams.extend({
  limit: OptionalFiniteNumber
})

const NoteShowParams = NoteScopedParams.extend({
  note: requiredString('Missing note selector')
})

const NoteCreateParams = NoteScopedParams.extend({
  title: requiredString('Missing note title'),
  bodyMarkdown: OptionalString,
  makeActive: z.boolean().optional()
})

const NoteAppendParams = NoteScopedParams.extend({
  note: requiredString('Missing note selector'),
  bodyMarkdown: requiredString('Missing note body'),
  makeActive: z.boolean().optional()
})

const NoteSearchParams = NoteScopedParams.extend({
  query: requiredString('Missing search query'),
  limit: OptionalFiniteNumber
})

export const NOTE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'note.list',
    params: NoteListParams,
    handler: async (params, { runtime }) =>
      await runtime.listNotes({
        worktreeSelector: params.worktree,
        limit: params.limit
      })
  }),
  defineMethod({
    name: 'note.show',
    params: NoteShowParams,
    handler: async (params, { runtime }) =>
      await runtime.showNote({
        worktreeSelector: params.worktree,
        note: params.note
      })
  }),
  defineMethod({
    name: 'note.create',
    params: NoteCreateParams,
    handler: async (params, { runtime }) =>
      await runtime.createNote({
        worktreeSelector: params.worktree,
        title: params.title,
        bodyMarkdown: params.bodyMarkdown,
        makeActive: params.makeActive
      })
  }),
  defineMethod({
    name: 'note.append',
    params: NoteAppendParams,
    handler: async (params, { runtime }) =>
      await runtime.appendNote({
        worktreeSelector: params.worktree,
        note: params.note,
        bodyMarkdown: params.bodyMarkdown,
        makeActive: params.makeActive
      })
  }),
  defineMethod({
    name: 'note.search',
    params: NoteSearchParams,
    handler: async (params, { runtime }) =>
      await runtime.searchNotes({
        worktreeSelector: params.worktree,
        query: params.query,
        limit: params.limit
      })
  })
]
