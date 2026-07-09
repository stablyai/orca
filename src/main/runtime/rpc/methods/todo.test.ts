import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorktreeTodo } from '../../../../shared/types'
import { TODO_METHODS } from './todo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function worktreeTodo(overrides: Partial<WorktreeTodo> = {}): WorktreeTodo {
  return {
    id: overrides.id ?? 'todo-1',
    scope: 'worktree',
    worktreeId: 'wt-1',
    body: overrides.body ?? 'Existing',
    order: overrides.order ?? 0,
    authorRole: overrides.authorRole ?? 'user',
    createdAt: overrides.createdAt ?? 1,
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {})
  }
}

describe('todo RPC methods', () => {
  it('adds an agent-authored worktree todo through the worktree meta mutator', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showManagedWorktree: vi.fn().mockResolvedValue({ id: 'wt-1', todos: [] }),
      updateManagedWorktreeMeta: vi
        .fn()
        .mockImplementation(async (_selector: string, updates: { todos: WorktreeTodo[] }) => ({
          id: 'wt-1',
          todos: updates.todos
        }))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TODO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('todo.add', { worktree: 'id:wt-1', body: '  Wire up endpoint  ' })
    )

    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        todos: expect.arrayContaining([
          expect.objectContaining({ body: 'Wire up endpoint', authorRole: 'agent' })
        ])
      })
    )
    expect(response).toMatchObject({
      ok: true,
      result: { scope: 'worktree', todo: { body: 'Wire up endpoint', authorRole: 'agent' } }
    })
  })

  it('adds an agent todo to the project list via repo.update for project scope', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showRepo: vi.fn().mockResolvedValue({ id: 'repo-1', todos: [] }),
      updateRepo: vi
        .fn()
        .mockImplementation(async (_selector: string, updates: { todos: WorktreeTodo[] }) => ({
          id: 'repo-1',
          todos: updates.todos
        }))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TODO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('todo.add', { repo: 'id:repo-1', scope: 'project', body: 'Update changelog' })
    )

    expect(runtime.showRepo).toHaveBeenCalledWith('id:repo-1')
    expect(runtime.updateRepo).toHaveBeenCalledWith(
      'id:repo-1',
      expect.objectContaining({
        todos: expect.arrayContaining([
          expect.objectContaining({ scope: 'project', repoId: 'repo-1', authorRole: 'agent' })
        ])
      })
    )
    expect(response).toMatchObject({ ok: true, result: { scope: 'project' } })
  })

  it('lists todos sorted with open items first', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showManagedWorktree: vi.fn().mockResolvedValue({
        id: 'wt-1',
        todos: [
          worktreeTodo({ id: 'done', order: 0, completedAt: 5 }),
          worktreeTodo({ id: 'open', order: 1 })
        ]
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TODO_METHODS })

    const response = await dispatcher.dispatch(makeRequest('todo.list', { worktree: 'id:wt-1' }))

    expect(response).toMatchObject({
      ok: true,
      result: { todos: [{ id: 'open' }, { id: 'done' }] }
    })
  })

  it('completes a todo and reports the change', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showManagedWorktree: vi
        .fn()
        .mockResolvedValue({ id: 'wt-1', todos: [worktreeTodo({ id: 'todo-1' })] }),
      updateManagedWorktreeMeta: vi
        .fn()
        .mockImplementation(async (_selector: string, updates: { todos: WorktreeTodo[] }) => ({
          id: 'wt-1',
          todos: updates.todos
        }))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TODO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('todo.complete', { worktree: 'id:wt-1', id: 'todo-1', completed: true })
    )

    expect(response).toMatchObject({ ok: true, result: { changed: true } })
    const result = (response as { result: { todo: WorktreeTodo } }).result
    expect(typeof result.todo.completedAt).toBe('number')
  })

  it('reports changed:false when completing an already-complete todo without writing', async () => {
    const updateManagedWorktreeMeta = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showManagedWorktree: vi
        .fn()
        .mockResolvedValue({ id: 'wt-1', todos: [worktreeTodo({ id: 'todo-1', completedAt: 5 })] }),
      updateManagedWorktreeMeta
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TODO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('todo.complete', { worktree: 'id:wt-1', id: 'todo-1', completed: true })
    )

    expect(response).toMatchObject({ ok: true, result: { changed: false } })
    expect(updateManagedWorktreeMeta).not.toHaveBeenCalled()
  })

  it('deletes a todo and persists the remaining list', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showManagedWorktree: vi
        .fn()
        .mockResolvedValue({ id: 'wt-1', todos: [worktreeTodo({ id: 'todo-1' })] }),
      updateManagedWorktreeMeta: vi
        .fn()
        .mockImplementation(async (_selector: string, updates: { todos: WorktreeTodo[] }) => ({
          id: 'wt-1',
          todos: updates.todos
        }))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TODO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('todo.delete', { worktree: 'id:wt-1', id: 'todo-1' })
    )

    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith('id:wt-1', { todos: [] })
    expect(response).toMatchObject({ ok: true, result: { deleted: true, id: 'todo-1', todos: [] } })
  })

  it('fails with a not-found error when the todo id is unknown', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showManagedWorktree: vi.fn().mockResolvedValue({ id: 'wt-1', todos: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TODO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('todo.delete', { worktree: 'id:wt-1', id: 'missing' })
    )

    expect(response).toMatchObject({ ok: false })
  })
})
