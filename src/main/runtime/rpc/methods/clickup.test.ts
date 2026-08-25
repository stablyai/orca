import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { CLICKUP_METHODS } from './clickup'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('ClickUp RPC methods', () => {
  it('routes account, task, mutation, and metadata methods', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      clickUpStatus: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      clickUpConnect: vi.fn().mockResolvedValue({ ok: true }),
      clickUpSelectWorkspace: vi.fn().mockResolvedValue({ connected: true }),
      clickUpSearchTasks: vi.fn().mockResolvedValue([]),
      clickUpListTasks: vi.fn().mockResolvedValue([]),
      clickUpGetTask: vi.fn().mockResolvedValue({ id: 'abc' }),
      clickUpCreateTask: vi.fn().mockResolvedValue({ ok: true }),
      clickUpUpdateTask: vi.fn().mockResolvedValue({ ok: true }),
      clickUpAddTaskComment: vi.fn().mockResolvedValue({ ok: true, id: 'comment-1' }),
      clickUpTaskComments: vi.fn().mockResolvedValue([]),
      clickUpListLists: vi.fn().mockResolvedValue([])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLICKUP_METHODS })

    await dispatcher.dispatch(makeRequest('clickup.status'))
    await dispatcher.dispatch(makeRequest('clickup.connect', { apiToken: ' pk_token ' }))
    await dispatcher.dispatch(makeRequest('clickup.selectWorkspace', { workspaceId: 'team-1' }))
    await dispatcher.dispatch(
      makeRequest('clickup.searchTasks', { query: 'auth', limit: 10, workspaceId: 'all' })
    )
    await dispatcher.dispatch(
      makeRequest('clickup.listTasks', {
        filter: 'assigned',
        limit: 20,
        workspaceId: 'team-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('clickup.getTask', { taskId: 'abc', workspaceId: 'team-1' })
    )
    await dispatcher.dispatch(
      makeRequest('clickup.createTask', {
        workspaceId: 'team-1',
        listId: 'list-1',
        name: 'Fix auth'
      })
    )
    await dispatcher.dispatch(
      makeRequest('clickup.updateTask', {
        taskId: 'abc',
        workspaceId: 'team-1',
        updates: { status: 'review', priority: 2 }
      })
    )
    await dispatcher.dispatch(
      makeRequest('clickup.addTaskComment', {
        taskId: 'abc',
        workspaceId: 'team-1',
        body: ' Ready '
      })
    )
    await dispatcher.dispatch(
      makeRequest('clickup.taskComments', { taskId: 'abc', workspaceId: 'team-1' })
    )
    await dispatcher.dispatch(makeRequest('clickup.listLists', { workspaceId: 'team-1' }))

    expect(runtime.clickUpConnect).toHaveBeenCalledWith('pk_token')
    expect(runtime.clickUpSearchTasks).toHaveBeenCalledWith('auth', 10, 'all')
    expect(runtime.clickUpListTasks).toHaveBeenCalledWith('assigned', 20, 'team-1')
    expect(runtime.clickUpGetTask).toHaveBeenCalledWith('abc', 'team-1')
    expect(runtime.clickUpCreateTask).toHaveBeenCalledWith({
      workspaceId: 'team-1',
      listId: 'list-1',
      name: 'Fix auth'
    })
    expect(runtime.clickUpUpdateTask).toHaveBeenCalledWith(
      'abc',
      { status: 'review', priority: 2 },
      'team-1'
    )
    expect(runtime.clickUpAddTaskComment).toHaveBeenCalledWith('abc', 'Ready', 'team-1')
    expect(runtime.clickUpTaskComments).toHaveBeenCalledWith('abc', 'team-1')
    expect(runtime.clickUpListLists).toHaveBeenCalledWith('team-1')
  })

  it('rejects malformed priorities and due dates before runtime dispatch', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      clickUpUpdateTask: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLICKUP_METHODS })

    await expect(
      dispatcher.dispatch(
        makeRequest('clickup.updateTask', {
          taskId: 'abc',
          updates: { priority: 5, dueDate: '07/31/2026' }
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.clickUpUpdateTask).not.toHaveBeenCalled()
  })
})
