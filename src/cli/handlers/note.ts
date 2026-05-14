import { readFileSync } from 'fs'
import type { NoteListResult, NoteMutationResult, NoteShowResult } from '../../shared/notes-types'
import type { CommandHandler } from '../dispatch'
import { formatNoteList, formatNoteMutation, formatNoteShow, printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserWorktreeSelector } from '../selectors'

async function getNoteWorktreeSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<string> {
  const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
  if (!worktree) {
    throw new RuntimeClientError(
      'selector_not_found',
      'No Orca-managed worktree contains the current directory. Pass --worktree.'
    )
  }
  return worktree
}

function readBody(flags: Map<string, string | boolean>, required: boolean): string | undefined {
  const body = getOptionalStringFlag(flags, 'body')
  const bodyFile = getOptionalStringFlag(flags, 'body-file')
  const bodyStdin = flags.get('body-stdin') === true
  const specified = [body !== undefined, bodyFile !== undefined, bodyStdin].filter(Boolean).length
  if (specified > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass only one of --body, --body-file, or --body-stdin'
    )
  }
  if (body !== undefined) {
    return body
  }
  if (bodyFile) {
    return readFileSync(bodyFile, 'utf8')
  }
  if (bodyStdin) {
    return readFileSync(0, 'utf8')
  }
  if (required) {
    throw new RuntimeClientError('invalid_argument', 'Missing note body')
  }
  return undefined
}

export const NOTE_HANDLERS: Record<string, CommandHandler> = {
  'note list': async ({ flags, client, cwd, json }) => {
    const result = await client.call<NoteListResult>('note.list', {
      worktree: await getNoteWorktreeSelector(flags, cwd, client),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatNoteList)
  },
  'note show': async ({ flags, client, cwd, json }) => {
    const result = await client.call<NoteShowResult>('note.show', {
      worktree: await getNoteWorktreeSelector(flags, cwd, client),
      note: getRequiredStringFlag(flags, 'note')
    })
    printResult(result, json, formatNoteShow)
  },
  'note create': async ({ flags, client, cwd, json }) => {
    const result = await client.call<NoteMutationResult>('note.create', {
      worktree: await getNoteWorktreeSelector(flags, cwd, client),
      title: getRequiredStringFlag(flags, 'title'),
      bodyMarkdown: readBody(flags, false),
      makeActive: true
    })
    printResult(result, json, formatNoteMutation)
  },
  'note append': async ({ flags, client, cwd, json }) => {
    const result = await client.call<NoteMutationResult>('note.append', {
      worktree: await getNoteWorktreeSelector(flags, cwd, client),
      note: getRequiredStringFlag(flags, 'note'),
      bodyMarkdown: readBody(flags, true),
      makeActive: true
    })
    printResult(result, json, formatNoteMutation)
  },
  'note search': async ({ flags, client, cwd, json }) => {
    const result = await client.call<NoteListResult>('note.search', {
      worktree: await getNoteWorktreeSelector(flags, cwd, client),
      query: getRequiredStringFlag(flags, 'query'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatNoteList)
  }
}
