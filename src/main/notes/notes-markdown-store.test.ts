import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotesMarkdownStore } from './notes-markdown-store'

describe('NotesMarkdownStore mutations', () => {
  let rootPath: string
  let store: NotesMarkdownStore

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'orca-notes-store-'))
    store = new NotesMarkdownStore()
  })

  afterEach(async () => {
    await rm(rootPath, { force: true, recursive: true })
  })

  it('renames the markdown file and keeps the note id stable', async () => {
    const created = await store.create(
      { projectId: 'repo-1', rootPath },
      {
        projectId: 'repo-1',
        worktreeId: 'wt-1',
        title: 'First note',
        bodyMarkdown: 'body'
      }
    )

    const renamed = await store.rename(
      { projectId: 'repo-1', rootPath },
      {
        projectId: 'repo-1',
        worktreeId: 'wt-1',
        note: created.note.id,
        title: 'Renamed note'
      }
    )

    expect(renamed.note.id).toBe(created.note.id)
    expect(renamed.note.title).toBe('Renamed note')
    expect(renamed.note.relativePath).toContain('renamed-note')

    const listed = await store.list(
      { projectId: 'repo-1', rootPath },
      { projectId: 'repo-1', worktreeId: 'wt-1' }
    )
    expect(listed.notes).toHaveLength(1)
    expect(listed.notes[0].title).toBe('Renamed note')
    expect(listed.notes[0].linkKind).toBe('active')
  })

  it('deletes the markdown file and clears worktree links', async () => {
    const created = await store.create(
      { projectId: 'repo-1', rootPath },
      {
        projectId: 'repo-1',
        worktreeId: 'wt-1',
        title: 'Delete me',
        bodyMarkdown: 'body'
      }
    )

    await store.delete(
      { projectId: 'repo-1', rootPath },
      { projectId: 'repo-1', worktreeId: 'wt-1', note: created.note.id }
    )

    const listed = await store.list(
      { projectId: 'repo-1', rootPath },
      { projectId: 'repo-1', worktreeId: 'wt-1' }
    )
    expect(listed.notes).toEqual([])
  })
})
