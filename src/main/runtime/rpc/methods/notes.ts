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
  makeActive: z.boolean().optional(),
  createdBySessionId: z.string().nullable().optional()
})

const NoteSaveParams = NoteScopedParams.extend({
  note: requiredString('Missing note selector'),
  title: OptionalString,
  bodyMarkdown: requiredString('Missing note body'),
  revision: OptionalFiniteNumber,
  makeActive: z.boolean().optional(),
  updatedBySessionId: z.string().nullable().optional()
})

const NoteRenameParams = NoteScopedParams.extend({
  note: requiredString('Missing note selector'),
  title: requiredString('Missing note title'),
  updatedBySessionId: z.string().nullable().optional()
})

const NoteDeleteParams = NoteScopedParams.extend({
  note: requiredString('Missing note selector')
})

const NoteAppendParams = NoteScopedParams.extend({
  note: requiredString('Missing note selector'),
  bodyMarkdown: requiredString('Missing note body'),
  makeActive: z.boolean().optional(),
  updatedBySessionId: z.string().nullable().optional()
})

const NoteSearchParams = NoteScopedParams.extend({
  query: requiredString('Missing search query'),
  limit: OptionalFiniteNumber
})

const NoteLinkParams = NoteScopedParams.extend({
  note: requiredString('Missing note selector'),
  kind: z.enum(['active', 'referenced'])
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
        makeActive: params.makeActive,
        createdBySessionId: params.createdBySessionId
      })
  }),
  defineMethod({
    name: 'note.save',
    params: NoteSaveParams,
    handler: async (params, { runtime }) =>
      await runtime.saveNote({
        worktreeSelector: params.worktree,
        note: params.note,
        title: params.title,
        bodyMarkdown: params.bodyMarkdown,
        revision: params.revision,
        makeActive: params.makeActive,
        updatedBySessionId: params.updatedBySessionId
      })
  }),
  defineMethod({
    name: 'note.rename',
    params: NoteRenameParams,
    handler: async (params, { runtime }) =>
      await runtime.renameNote({
        worktreeSelector: params.worktree,
        note: params.note,
        title: params.title,
        updatedBySessionId: params.updatedBySessionId
      })
  }),
  defineMethod({
    name: 'note.delete',
    params: NoteDeleteParams,
    handler: async (params, { runtime }) =>
      await runtime.deleteNote({
        worktreeSelector: params.worktree,
        note: params.note
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
        makeActive: params.makeActive,
        updatedBySessionId: params.updatedBySessionId
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
  }),
  defineMethod({
    name: 'note.link',
    params: NoteLinkParams,
    handler: async (params, { runtime }) =>
      await runtime.linkNote({
        worktreeSelector: params.worktree,
        note: params.note,
        kind: params.kind
      })
  }),
  defineMethod({
    name: 'note.panelState',
    params: NoteScopedParams,
    handler: async (params, { runtime }) =>
      await runtime.resolveNotesPanelOpenStateForWorktree({
        worktreeSelector: params.worktree
      })
  })
]
