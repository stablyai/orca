import { randomUUID } from 'node:crypto'
import type { DiffComment } from '../../shared/diff-comment-types'
import type {
  RuntimeWorktreeRecord,
  RuntimeWorktreeSetResult
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  isRuntimePathAbsolute,
  normalizeRelativePath,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import { folderIdOfSelector } from '../../shared/workspace/identity/workspace-scope'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { readCommandBody } from '../arguments/command-body-input'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  getOptionalWorktreeSelector,
  resolveCurrentWorktreeSelector
} from '../workspace-selection/workspace-selector'
import { writeFolderWorkspaceDiffComments } from './folder-workspace-mutations'
import { formatAddedNote, formatClearedNotes, formatNoteList } from './worktree-notes-format'

type NotesTarget = {
  selector: string
  shown: RuntimeRpcSuccess<{ worktree: RuntimeWorktreeRecord }>
  notes: DiffComment[]
}

async function readNotesTarget({ flags, client, cwd }: HandlerContext): Promise<NotesTarget> {
  const selector =
    (await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)) ??
    (await resolveCurrentWorktreeSelector(cwd, client))
  const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector,
    matchFolderWorkspaces: true
  })
  return { selector, shown, notes: shown.result.worktree.diffComments ?? [] }
}

// Sends the list it read as the base, so the host applies only this change and keeps notes saved meanwhile.
async function writeNotes(
  { client }: HandlerContext,
  target: NotesTarget,
  next: DiffComment[]
): Promise<DiffComment[]> {
  const folderId = folderIdOfSelector(target.shown.result.worktree.id)
  if (folderId !== undefined) {
    return writeFolderWorkspaceDiffComments(client, folderId, next, target.notes)
  }
  const updated = await client.call<RuntimeWorktreeSetResult>('worktree.set', {
    worktree: target.selector,
    diffComments: next,
    diffCommentsBase: target.notes
  })
  return updated.result.worktree.diffComments ?? []
}

function getNoteFilePath(
  flags: Map<string, string | boolean>,
  record: RuntimeWorktreeRecord
): string | undefined {
  const raw = getOptionalStringFlag(flags, 'file')
  if (raw === undefined) {
    return undefined
  }
  const inside = isRuntimePathAbsolute(raw) ? relativePathInsideRoot(record.path, raw) : raw
  const filePath = normalizeRelativePath(inside ?? '', record.path).replace(/^(\.\/)+/, '')
  if (!filePath || filePath === '.' || filePath.split('/').includes('..')) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--file must name a file inside the workspace at ${record.path}.`
    )
  }
  return filePath
}

function getNoteLines(flags: Map<string, string | boolean>): {
  lineNumber: number
  startLine?: number
} {
  const lineNumber = getOptionalPositiveIntegerFlag(flags, 'line')
  if (lineNumber === undefined) {
    throw new RuntimeClientError('invalid_argument', 'Missing --line <n>.')
  }
  const startLine = getOptionalPositiveIntegerFlag(flags, 'start-line')
  if (startLine !== undefined && startLine > lineNumber) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--start-line ${startLine} must not be after --line ${lineNumber}.`
    )
  }
  return startLine !== undefined && startLine < lineNumber
    ? { lineNumber, startLine }
    : { lineNumber }
}

function notSaved(): RuntimeClientError {
  return new RuntimeClientError(
    'note_not_saved',
    'Orca did not save the change to the review notes. Update Orca and try again.'
  )
}

export const WORKTREE_NOTES_HANDLERS: Record<string, CommandHandler> = {
  'worktree notes list': async (ctx) => {
    const target = await readNotesTarget(ctx)
    const record = target.shown.result.worktree
    const filePath = getNoteFilePath(ctx.flags, record)
    const notes = target.notes.filter((note) => !filePath || note.filePath === filePath)
    printResult(
      { ...target.shown, result: { worktree: record.id, notes } },
      ctx.json,
      formatNoteList
    )
  },
  'worktree notes add': async (ctx) => {
    const { flags } = ctx
    // Validate every input before any request so a bad call changes nothing.
    if (getOptionalStringFlag(flags, 'file') === undefined) {
      throw new RuntimeClientError('invalid_argument', 'Missing --file <path>.')
    }
    const lines = getNoteLines(flags)
    const body = (
      await readCommandBody(flags, ctx.cwd, {
        required: true,
        maximumCharacters: 100_000,
        tooLargeCode: 'note_body_too_large',
        label: 'Note body'
      })
    ).trim()
    if (!body) {
      throw new RuntimeClientError('invalid_argument', 'Note body cannot be blank.')
    }
    const target = await readNotesTarget(ctx)
    const record = target.shown.result.worktree
    const note: DiffComment = {
      id: randomUUID(),
      worktreeId: record.id,
      filePath: getNoteFilePath(flags, record) ?? '',
      source: 'diff',
      ...lines,
      body,
      createdAt: Date.now(),
      side: 'modified'
    }
    const saved = await writeNotes(ctx, target, [...target.notes, note])
    if (!saved.some((entry) => entry.id === note.id)) {
      throw notSaved()
    }
    printResult(
      { ...target.shown, result: { worktree: record.id, note } },
      ctx.json,
      formatAddedNote
    )
  },
  'worktree notes clear': async (ctx) => {
    const { flags } = ctx
    const ids = getRepeatedStringFlag(flags, 'id')
    const all = flags.get('all') === true
    const modes = [ids.length > 0, flags.has('file'), all].filter(Boolean).length
    if (modes !== 1) {
      throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --id, --file or --all.')
    }
    const target = await readNotesTarget(ctx)
    const record = target.shown.result.worktree
    const missing = ids.filter((id) => !target.notes.some((note) => note.id === id))
    if (missing.length > 0) {
      throw new RuntimeClientError(
        'note_not_found',
        `No review note with id ${missing.join(', ')}. Nothing was deleted. List notes with orca worktree notes list --json.`
      )
    }
    const filePath = getNoteFilePath(flags, record)
    const removed = target.notes.filter(
      (note) => all || ids.includes(note.id) || note.filePath === filePath
    )
    if (removed.length > 0) {
      const removedIds = new Set(removed.map((note) => note.id))
      const saved = await writeNotes(
        ctx,
        target,
        target.notes.filter((note) => !removedIds.has(note.id))
      )
      if (saved.some((note) => removedIds.has(note.id))) {
        throw notSaved()
      }
    }
    printResult(
      { ...target.shown, result: { worktree: record.id, removed } },
      ctx.json,
      formatClearedNotes
    )
  }
}
