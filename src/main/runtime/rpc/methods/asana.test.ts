import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { ASANA_METHODS } from './asana'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('asana RPC methods', () => {
  it('routes Asana account methods to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      asanaStatus: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      asanaTestConnection: vi.fn().mockResolvedValue({ ok: true, viewer: { name: 'Ada' } }),
      asanaConnect: vi.fn().mockResolvedValue({ ok: true, viewer: { name: 'Ada' } }),
      asanaSelectWorkspace: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      asanaDisconnect: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: ASANA_METHODS })

    await dispatcher.dispatch(makeRequest('asana.status'))
    await dispatcher.dispatch(makeRequest('asana.testConnection'))
    await dispatcher.dispatch(makeRequest('asana.connect', { apiToken: 'pat-1' }))
    await dispatcher.dispatch(makeRequest('asana.selectWorkspace', { workspaceId: 'ws-1' }))
    await dispatcher.dispatch(makeRequest('asana.disconnect'))

    expect(runtime.asanaStatus).toHaveBeenCalled()
    expect(runtime.asanaTestConnection).toHaveBeenCalled()
    expect(runtime.asanaConnect).toHaveBeenCalledWith({ apiToken: 'pat-1' })
    expect(runtime.asanaSelectWorkspace).toHaveBeenCalledWith('ws-1')
    expect(runtime.asanaDisconnect).toHaveBeenCalled()
  })

  it('routes Asana task queries and mutations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      asanaSearchTasks: vi.fn().mockResolvedValue([{ gid: '1' }]),
      asanaListTasks: vi.fn().mockResolvedValue([{ gid: '2' }]),
      asanaGetTask: vi.fn().mockResolvedValue({ gid: '3' }),
      asanaCreateTask: vi.fn().mockResolvedValue({ ok: true, gid: '4' }),
      asanaUpdateTask: vi.fn().mockResolvedValue({ ok: true }),
      asanaAddTaskComment: vi.fn().mockResolvedValue({ ok: true, id: 'story-1' }),
      asanaTaskComments: vi.fn().mockResolvedValue([{ gid: 'story-2' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: ASANA_METHODS })

    await dispatcher.dispatch(
      makeRequest('asana.searchTasks', { query: 'login', limit: 30, workspaceId: 'all' })
    )
    await dispatcher.dispatch(
      makeRequest('asana.listTasks', {
        filter: 'assigned',
        limit: 20,
        workspaceId: 'ws-1',
        projectId: 'proj-1'
      })
    )
    await dispatcher.dispatch(makeRequest('asana.getTask', { gid: '3', workspaceId: 'ws-1' }))
    await dispatcher.dispatch(
      makeRequest('asana.createTask', {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        title: 'New task',
        notes: 'Body'
      })
    )
    await dispatcher.dispatch(
      makeRequest('asana.updateTask', {
        gid: '3',
        workspaceId: 'ws-1',
        updates: { title: 'Updated', completed: true, assigneeGid: null, dueOn: null }
      })
    )
    await dispatcher.dispatch(
      makeRequest('asana.addTaskComment', { gid: '3', text: 'Looks good', workspaceId: 'ws-1' })
    )
    await dispatcher.dispatch(makeRequest('asana.taskComments', { gid: '3', workspaceId: 'ws-1' }))

    expect(runtime.asanaSearchTasks).toHaveBeenCalledWith('login', 30, 'all')
    expect(runtime.asanaListTasks).toHaveBeenCalledWith('assigned', 20, 'ws-1', 'proj-1')
    expect(runtime.asanaGetTask).toHaveBeenCalledWith('3', 'ws-1')
    expect(runtime.asanaCreateTask).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      title: 'New task',
      notes: 'Body',
      assigneeGid: undefined
    })
    expect(runtime.asanaUpdateTask).toHaveBeenCalledWith(
      '3',
      { title: 'Updated', completed: true, assigneeGid: null, dueOn: null },
      'ws-1'
    )
    expect(runtime.asanaAddTaskComment).toHaveBeenCalledWith('3', 'Looks good', 'ws-1')
    expect(runtime.asanaTaskComments).toHaveBeenCalledWith('3', 'ws-1')
  })

  it('routes Asana metadata requests to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      asanaListProjects: vi.fn().mockResolvedValue([{ gid: 'proj-1' }]),
      asanaListSections: vi.fn().mockResolvedValue([{ gid: 'section-1' }]),
      asanaListAssignableUsers: vi.fn().mockResolvedValue([{ gid: 'user-1' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: ASANA_METHODS })

    await dispatcher.dispatch(makeRequest('asana.listProjects', { workspaceId: 'all' }))
    await dispatcher.dispatch(
      makeRequest('asana.listSections', { projectGid: 'proj-1', workspaceId: 'ws-1' })
    )
    await dispatcher.dispatch(
      makeRequest('asana.listAssignableUsers', { workspaceId: 'ws-1', query: 'Ada' })
    )

    expect(runtime.asanaListProjects).toHaveBeenCalledWith('all')
    expect(runtime.asanaListSections).toHaveBeenCalledWith('proj-1', 'ws-1')
    expect(runtime.asanaListAssignableUsers).toHaveBeenCalledWith('ws-1', 'Ada')
  })
})
