import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { NOTE_METHODS } from './notes'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('notes RPC methods', () => {
  it('routes note reads through the selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listNotes: vi.fn().mockResolvedValue({ notes: [], totalCount: 0, truncated: false }),
      showNote: vi.fn().mockResolvedValue({ note: { id: 'note-1' }, linkKind: null })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: NOTE_METHODS })

    await dispatcher.dispatch(makeRequest('note.list', { worktree: 'id:wt-1', limit: 50 }))
    await dispatcher.dispatch(makeRequest('note.show', { worktree: 'id:wt-1', note: 'note-1' }))

    expect(runtime.listNotes).toHaveBeenCalledWith({ worktreeSelector: 'id:wt-1', limit: 50 })
    expect(runtime.showNote).toHaveBeenCalledWith({
      worktreeSelector: 'id:wt-1',
      note: 'note-1'
    })
  })

  it('routes note mutations through the selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createNote: vi.fn().mockResolvedValue({ note: { id: 'created' }, linkKind: 'active' }),
      saveNote: vi.fn().mockResolvedValue({ note: { id: 'note-1' }, linkKind: 'active' }),
      renameNote: vi.fn().mockResolvedValue({ note: { id: 'note-1' }, linkKind: null }),
      deleteNote: vi.fn().mockResolvedValue({ noteId: 'note-1', projectId: 'repo-1' }),
      appendNote: vi.fn().mockResolvedValue({ note: { id: 'note-1' }, linkKind: null }),
      linkNote: vi.fn().mockResolvedValue({
        noteId: 'note-1',
        projectId: 'repo-1',
        worktreeId: 'wt-1',
        kind: 'active',
        createdAt: 'now'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: NOTE_METHODS })

    await dispatcher.dispatch(
      makeRequest('note.create', {
        worktree: 'id:wt-1',
        title: 'Plan',
        bodyMarkdown: 'body',
        makeActive: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('note.save', {
        worktree: 'id:wt-1',
        note: 'note-1',
        title: 'Plan v2',
        bodyMarkdown: 'updated',
        revision: 2,
        makeActive: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('note.rename', { worktree: 'id:wt-1', note: 'note-1', title: 'Renamed' })
    )
    await dispatcher.dispatch(makeRequest('note.delete', { worktree: 'id:wt-1', note: 'note-1' }))
    await dispatcher.dispatch(
      makeRequest('note.append', {
        worktree: 'id:wt-1',
        note: 'note-1',
        bodyMarkdown: 'more',
        makeActive: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('note.link', { worktree: 'id:wt-1', note: 'note-1', kind: 'active' })
    )

    expect(runtime.createNote).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSelector: 'id:wt-1',
        title: 'Plan',
        bodyMarkdown: 'body',
        makeActive: true
      })
    )
    expect(runtime.saveNote).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSelector: 'id:wt-1',
        note: 'note-1',
        title: 'Plan v2',
        bodyMarkdown: 'updated',
        revision: 2,
        makeActive: true
      })
    )
    expect(runtime.renameNote).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSelector: 'id:wt-1',
        note: 'note-1',
        title: 'Renamed'
      })
    )
    expect(runtime.deleteNote).toHaveBeenCalledWith({
      worktreeSelector: 'id:wt-1',
      note: 'note-1'
    })
    expect(runtime.appendNote).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSelector: 'id:wt-1',
        note: 'note-1',
        bodyMarkdown: 'more',
        makeActive: true
      })
    )
    expect(runtime.linkNote).toHaveBeenCalledWith({
      worktreeSelector: 'id:wt-1',
      note: 'note-1',
      kind: 'active'
    })
  })

  it('routes panel state and search through the selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchNotes: vi.fn().mockResolvedValue({ notes: [], totalCount: 0, truncated: false }),
      resolveNotesPanelOpenStateForWorktree: vi.fn().mockResolvedValue({ state: 'emptyDraft' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: NOTE_METHODS })

    await dispatcher.dispatch(
      makeRequest('note.search', { worktree: 'id:wt-1', query: 'todo', limit: 20 })
    )
    await dispatcher.dispatch(makeRequest('note.panelState', { worktree: 'id:wt-1' }))

    expect(runtime.searchNotes).toHaveBeenCalledWith({
      worktreeSelector: 'id:wt-1',
      query: 'todo',
      limit: 20
    })
    expect(runtime.resolveNotesPanelOpenStateForWorktree).toHaveBeenCalledWith({
      worktreeSelector: 'id:wt-1'
    })
  })
})
