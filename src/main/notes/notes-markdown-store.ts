/* eslint-disable max-lines -- Why: note file serialization, index updates, and selector resolution need one persistence boundary so Markdown files stay user-owned without splitting active-link invariants across modules. */
import { randomBytes } from 'crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { join, posix } from 'path'
import type { IFilesystemProvider } from '../providers/types'
import type {
  NoteAppendArgs,
  NoteCreateArgs,
  NoteDeleteArgs,
  NoteDeleteResult,
  NoteLink,
  NoteLinkArgs,
  NoteLinkKind,
  NoteListArgs,
  NoteListResult,
  NoteMutationResult,
  NoteRecord,
  NoteRenameArgs,
  NoteSaveArgs,
  NoteSearchArgs,
  NoteShowArgs,
  NoteShowResult,
  NoteSummary,
  NotesPanelOpenState,
  NotesPanelStateArgs
} from '../../shared/notes-types'

type NotesMarkdownScope = {
  projectId: string
  rootPath: string
  connectionId?: string | null
  provider?: IFilesystemProvider
}

type NotesIndex = {
  version: 1
  activeByWorktree: Record<string, string>
  referencedByWorktree: Record<string, string[]>
}

type NoteFrontMatter = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  createdBySessionId: string | null
  updatedBySessionId: string | null
  revision: number
}

const NOTES_DIR = 'notes'
const INDEX_FILE = 'index.json'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function nowIso(): string {
  return new Date().toISOString()
}

function generateId(): string {
  return `note_${randomBytes(8).toString('hex')}`
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) {
    return DEFAULT_LIMIT
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function pathJoin(scope: NotesMarkdownScope, ...parts: string[]): string {
  return scope.connectionId ? posix.join(scope.rootPath, ...parts) : join(scope.rootPath, ...parts)
}

function slugTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'untitled-note'
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  )
}

function emptyIndex(): NotesIndex {
  return {
    version: 1,
    activeByWorktree: {},
    referencedByWorktree: {}
  }
}

function notePreview(bodyMarkdown: string): string {
  return bodyMarkdown.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function parseFrontMatterValue(raw: string): string | number | null {
  const value = raw.trim()
  if (value === 'null') {
    return null
  }
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10)
  }
  if (value.startsWith('"')) {
    return JSON.parse(value) as string
  }
  return value
}

function parseNoteFile(
  projectId: string,
  filePath: string,
  relativePath: string,
  raw: string
): NoteRecord {
  if (!raw.startsWith('---\n')) {
    throw new Error('invalid_note_file')
  }
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) {
    throw new Error('invalid_note_file')
  }
  const frontMatter = raw.slice(4, end)
  const bodyMarkdown = raw.slice(end + 5)
  const parsed: Partial<NoteFrontMatter> = {}
  for (const line of frontMatter.split('\n')) {
    const index = line.indexOf(':')
    if (index === -1) {
      continue
    }
    const key = line.slice(0, index).trim() as keyof NoteFrontMatter
    const value = parseFrontMatterValue(line.slice(index + 1))
    ;(parsed as Record<string, unknown>)[key] = value
  }
  if (!parsed.id || !parsed.title || !parsed.createdAt || !parsed.updatedAt) {
    throw new Error('invalid_note_file')
  }
  return {
    id: parsed.id,
    projectId,
    filePath,
    relativePath,
    title: parsed.title,
    bodyMarkdown,
    revision: typeof parsed.revision === 'number' ? parsed.revision : 1,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    archivedAt: parsed.archivedAt ?? null,
    createdBySessionId: parsed.createdBySessionId ?? null,
    updatedBySessionId: parsed.updatedBySessionId ?? null
  }
}

function serializeNote(note: NoteRecord): string {
  const frontMatter: NoteFrontMatter = {
    id: note.id,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    archivedAt: note.archivedAt,
    createdBySessionId: note.createdBySessionId ?? null,
    updatedBySessionId: note.updatedBySessionId ?? null,
    revision: note.revision
  }
  const lines = Object.entries(frontMatter).map(([key, value]) => {
    if (typeof value === 'string') {
      return `${key}: ${JSON.stringify(value)}`
    }
    return `${key}: ${value === null ? 'null' : value}`
  })
  return `---\n${lines.join('\n')}\n---\n${note.bodyMarkdown}`
}

function linkKindForNote(
  index: NotesIndex,
  noteId: string,
  worktreeId?: string | null
): NoteLinkKind | null {
  if (!worktreeId) {
    return null
  }
  if (index.activeByWorktree[worktreeId] === noteId) {
    return 'active'
  }
  if ((index.referencedByWorktree[worktreeId] ?? []).includes(noteId)) {
    return 'referenced'
  }
  return null
}

function toSummary(note: NoteRecord, index: NotesIndex, worktreeId?: string | null): NoteSummary {
  return {
    ...note,
    preview: notePreview(note.bodyMarkdown),
    linkKind: linkKindForNote(index, note.id, worktreeId)
  }
}

export class NotesMarkdownStore {
  async list(scope: NotesMarkdownScope, args: NoteListArgs): Promise<NoteListResult> {
    const limit = clampLimit(args.limit)
    const [notes, index] = await Promise.all([this.readNotes(scope), this.readIndex(scope)])
    const visible = notes
      .filter((note) => note.archivedAt === null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const sorted = visible.sort((left, right) => {
      const leftLink = linkKindForNote(index, left.id, args.worktreeId)
      const rightLink = linkKindForNote(index, right.id, args.worktreeId)
      const rank = (kind: NoteLinkKind | null): number =>
        kind === 'active' ? 0 : kind === 'referenced' ? 1 : 2
      return rank(leftLink) - rank(rightLink) || right.updatedAt.localeCompare(left.updatedAt)
    })
    return {
      notes: sorted.slice(0, limit).map((note) => toSummary(note, index, args.worktreeId)),
      totalCount: sorted.length,
      truncated: sorted.length > limit
    }
  }

  async show(scope: NotesMarkdownScope, args: NoteShowArgs): Promise<NoteShowResult> {
    const [note, index] = await Promise.all([
      this.resolveNote(scope, args.note),
      this.readIndex(scope)
    ])
    return {
      note,
      linkKind: linkKindForNote(index, note.id, args.worktreeId)
    }
  }

  async create(scope: NotesMarkdownScope, args: NoteCreateArgs): Promise<NoteMutationResult> {
    const at = nowIso()
    const id = generateId()
    const title = args.title.trim() || 'Untitled note'
    const note: NoteRecord = {
      id,
      projectId: scope.projectId,
      filePath: this.notePath(scope, title, id),
      relativePath: posix.join(NOTES_DIR, `${slugTitle(title)}-${id}.md`),
      title,
      bodyMarkdown: args.bodyMarkdown ?? '',
      revision: 1,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      createdBySessionId: args.createdBySessionId ?? null,
      updatedBySessionId: args.createdBySessionId ?? null
    }
    await this.writeNote(scope, note)
    if (args.makeActive !== false && args.worktreeId) {
      await this.setLink(scope, {
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        note: note.id,
        kind: 'active'
      })
    }
    const index = await this.readIndex(scope)
    return {
      note,
      linkKind: linkKindForNote(index, note.id, args.worktreeId)
    }
  }

  async save(scope: NotesMarkdownScope, args: NoteSaveArgs): Promise<NoteMutationResult> {
    const current = await this.resolveNote(scope, args.note)
    if (args.revision !== undefined && args.revision !== current.revision) {
      throw new Error('revision_conflict')
    }
    const next: NoteRecord = {
      ...current,
      title: args.title?.trim() || current.title,
      bodyMarkdown: args.bodyMarkdown,
      revision: current.revision + 1,
      updatedAt: nowIso(),
      updatedBySessionId: args.updatedBySessionId ?? null
    }
    await this.writeNote(scope, next)
    if (args.makeActive === true && args.worktreeId) {
      await this.setLink(scope, {
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        note: next.id,
        kind: 'active'
      })
    }
    const index = await this.readIndex(scope)
    return {
      note: next,
      linkKind: linkKindForNote(index, next.id, args.worktreeId)
    }
  }

  async rename(scope: NotesMarkdownScope, args: NoteRenameArgs): Promise<NoteMutationResult> {
    const current = await this.resolveNote(scope, args.note)
    const title = args.title.trim()
    if (!title) {
      throw new Error('invalid_note_title')
    }
    const nextPath = this.notePath(scope, title, current.id)
    const nextRelativePath = posix.join(NOTES_DIR, `${slugTitle(title)}-${current.id}.md`)
    const next: NoteRecord = {
      ...current,
      filePath: nextPath,
      relativePath: nextRelativePath,
      title,
      revision: current.revision + 1,
      updatedAt: nowIso(),
      updatedBySessionId: args.updatedBySessionId ?? null
    }
    if (next.filePath !== current.filePath) {
      await this.renamePath(scope, current.filePath, next.filePath)
    }
    await this.writeNote(scope, next)
    const index = await this.readIndex(scope)
    return {
      note: next,
      linkKind: linkKindForNote(index, next.id, args.worktreeId)
    }
  }

  async delete(scope: NotesMarkdownScope, args: NoteDeleteArgs): Promise<NoteDeleteResult> {
    const note = await this.resolveNote(scope, args.note)
    await this.deletePath(scope, note.filePath)
    const index = await this.readIndex(scope)
    for (const [worktreeId, noteId] of Object.entries(index.activeByWorktree)) {
      if (noteId === note.id) {
        delete index.activeByWorktree[worktreeId]
      }
    }
    for (const [worktreeId, noteIds] of Object.entries(index.referencedByWorktree)) {
      const next = noteIds.filter((noteId) => noteId !== note.id)
      if (next.length === 0) {
        delete index.referencedByWorktree[worktreeId]
      } else {
        index.referencedByWorktree[worktreeId] = next
      }
    }
    await this.writeIndex(scope, index)
    return {
      noteId: note.id,
      projectId: scope.projectId
    }
  }

  async append(scope: NotesMarkdownScope, args: NoteAppendArgs): Promise<NoteMutationResult> {
    const current = await this.resolveNote(scope, args.note)
    const separator = current.bodyMarkdown.trim().length > 0 ? '\n\n' : ''
    return await this.save(scope, {
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      note: current.id,
      title: current.title,
      bodyMarkdown: `${current.bodyMarkdown}${separator}${args.bodyMarkdown}`,
      makeActive: args.makeActive,
      updatedBySessionId: args.updatedBySessionId
    })
  }

  async search(scope: NotesMarkdownScope, args: NoteSearchArgs): Promise<NoteListResult> {
    const limit = clampLimit(args.limit)
    const query = args.query.trim().toLowerCase()
    const [notes, index] = await Promise.all([this.readNotes(scope), this.readIndex(scope)])
    const matches = notes
      .filter(
        (note) =>
          note.archivedAt === null &&
          (note.title.toLowerCase().includes(query) ||
            note.bodyMarkdown.toLowerCase().includes(query))
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return {
      notes: matches.slice(0, limit).map((note) => toSummary(note, index, args.worktreeId)),
      totalCount: matches.length,
      truncated: matches.length > limit
    }
  }

  async setLink(scope: NotesMarkdownScope, args: NoteLinkArgs): Promise<NoteLink> {
    const note = await this.resolveNote(scope, args.note)
    const index = await this.readIndex(scope)
    if (args.kind === 'active') {
      index.activeByWorktree[args.worktreeId] = note.id
    } else {
      const existing = index.referencedByWorktree[args.worktreeId] ?? []
      index.referencedByWorktree[args.worktreeId] = Array.from(new Set([...existing, note.id]))
    }
    await this.writeIndex(scope, index)
    return {
      noteId: note.id,
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      kind: args.kind,
      createdAt: nowIso()
    }
  }

  async unlinkWorktree(scope: NotesMarkdownScope, worktreeId: string): Promise<void> {
    const index = await this.readIndex(scope)
    delete index.activeByWorktree[worktreeId]
    delete index.referencedByWorktree[worktreeId]
    await this.writeIndex(scope, index)
  }

  async resolvePanelOpenState(
    scope: NotesMarkdownScope | null,
    args: NotesPanelStateArgs
  ): Promise<NotesPanelOpenState> {
    if (!scope || !args.projectId) {
      return { state: 'noProject' }
    }
    const [notes, index] = await Promise.all([this.readNotes(scope), this.readIndex(scope)])
    if (args.worktreeId) {
      const activeId = index.activeByWorktree[args.worktreeId]
      const active = notes.find((note) => note.id === activeId && note.archivedAt === null)
      if (active) {
        return {
          state: 'active',
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          note: active
        }
      }
    }
    const summaries = notes
      .filter((note) => note.archivedAt === null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((note) => toSummary(note, index, args.worktreeId))
    if (summaries.length > 0) {
      return {
        state: 'pickerRequired',
        projectId: args.projectId,
        worktreeId: args.worktreeId ?? null,
        notes: summaries
      }
    }
    return {
      state: 'emptyDraft',
      projectId: args.projectId,
      worktreeId: args.worktreeId ?? null
    }
  }

  private notesDir(scope: NotesMarkdownScope): string {
    return pathJoin(scope, NOTES_DIR)
  }

  private indexPath(scope: NotesMarkdownScope): string {
    return pathJoin(scope, NOTES_DIR, INDEX_FILE)
  }

  private notePath(scope: NotesMarkdownScope, title: string, id: string): string {
    return pathJoin(scope, NOTES_DIR, `${slugTitle(title)}-${id}.md`)
  }

  private async ensureNotesDir(scope: NotesMarkdownScope): Promise<void> {
    if (scope.provider) {
      await scope.provider.createDir(this.notesDir(scope))
      return
    }
    await mkdir(this.notesDir(scope), { recursive: true })
  }

  private async readText(scope: NotesMarkdownScope, filePath: string): Promise<string> {
    if (scope.provider) {
      return (await scope.provider.readFile(filePath)).content
    }
    return await readFile(filePath, 'utf8')
  }

  private async writeText(
    scope: NotesMarkdownScope,
    filePath: string,
    content: string
  ): Promise<void> {
    await this.ensureNotesDir(scope)
    if (scope.provider) {
      await scope.provider.writeFile(filePath, content)
      return
    }
    await writeFile(filePath, content, 'utf8')
  }

  private async renamePath(
    scope: NotesMarkdownScope,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    await this.ensureNotesDir(scope)
    if (scope.provider) {
      await scope.provider.rename(oldPath, newPath)
      return
    }
    await rename(oldPath, newPath)
  }

  private async deletePath(scope: NotesMarkdownScope, filePath: string): Promise<void> {
    if (scope.provider) {
      await scope.provider.deletePath(filePath)
      return
    }
    await rm(filePath, { force: true })
  }

  private async readIndex(scope: NotesMarkdownScope): Promise<NotesIndex> {
    try {
      const raw = await this.readText(scope, this.indexPath(scope))
      const parsed = JSON.parse(raw) as Partial<NotesIndex>
      return {
        version: 1,
        activeByWorktree: parsed.activeByWorktree ?? {},
        referencedByWorktree: parsed.referencedByWorktree ?? {}
      }
    } catch (error) {
      if (isMissingFile(error)) {
        return emptyIndex()
      }
      throw error
    }
  }

  private async writeIndex(scope: NotesMarkdownScope, index: NotesIndex): Promise<void> {
    await this.writeText(scope, this.indexPath(scope), `${JSON.stringify(index, null, 2)}\n`)
  }

  private async readNotes(scope: NotesMarkdownScope): Promise<NoteRecord[]> {
    let names: string[]
    try {
      if (scope.provider) {
        const entries = await scope.provider.readDir(this.notesDir(scope))
        names = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name)
      } else {
        names = await readdir(this.notesDir(scope))
      }
    } catch (error) {
      if (isMissingFile(error)) {
        return []
      }
      throw error
    }
    const files = names.filter((name) => name.endsWith('.md'))
    const notes = await Promise.all(
      files.map(async (name) => {
        const filePath = pathJoin(scope, NOTES_DIR, name)
        const relativePath = posix.join(NOTES_DIR, name)
        const raw = await this.readText(scope, filePath)
        return parseNoteFile(scope.projectId, filePath, relativePath, raw)
      })
    )
    return notes
  }

  private async writeNote(scope: NotesMarkdownScope, note: NoteRecord): Promise<void> {
    await this.writeText(scope, note.filePath, serializeNote(note))
  }

  private async resolveNote(scope: NotesMarkdownScope, selector: string): Promise<NoteRecord> {
    const normalized = selector.trim().toLowerCase()
    const notes = await this.readNotes(scope)
    const matches = notes.filter(
      (note) =>
        note.archivedAt === null &&
        (note.id === selector ||
          note.title.toLowerCase() === normalized ||
          note.relativePath === selector ||
          note.filePath === selector)
    )
    if (matches.length === 0) {
      throw new Error('note_not_found')
    }
    if (matches.length > 1) {
      throw new Error('note_ambiguous')
    }
    return matches[0]
  }
}
