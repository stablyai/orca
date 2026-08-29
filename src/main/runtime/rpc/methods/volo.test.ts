import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { VOLO_METHODS } from './volo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('volo RPC methods', () => {
  it('routes Volo account methods to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      voloStatus: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      voloReadStatus: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      voloTestConnection: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      voloConnect: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      voloConnectFromSavedCredentials: vi
        .fn()
        .mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      voloDisconnect: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: VOLO_METHODS })

    await dispatcher.dispatch(makeRequest('volo.status'))
    await dispatcher.dispatch(makeRequest('volo.readStatus'))
    await dispatcher.dispatch(makeRequest('volo.testConnection'))
    await dispatcher.dispatch(
      makeRequest('volo.connect', {
        apiUrl: 'https://volo.api.jaak.ai',
        apiToken: 'jk_token'
      })
    )
    await dispatcher.dispatch(makeRequest('volo.connectFromSavedCredentials'))
    await dispatcher.dispatch(makeRequest('volo.disconnect'))

    expect(runtime.voloStatus).toHaveBeenCalled()
    expect(runtime.voloReadStatus).toHaveBeenCalled()
    expect(runtime.voloTestConnection).toHaveBeenCalled()
    expect(runtime.voloConnect).toHaveBeenCalledWith({
      apiToken: 'jk_token',
      apiUrl: 'https://volo.api.jaak.ai',
      webUrl: undefined
    })
    expect(runtime.voloConnectFromSavedCredentials).toHaveBeenCalled()
    expect(runtime.voloDisconnect).toHaveBeenCalled()
  })

  it('routes Volo board and task methods to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      voloListBoards: vi.fn().mockResolvedValue([{ id: 'b1' }]),
      voloListMembers: vi.fn().mockResolvedValue([]),
      voloListTasks: vi.fn().mockResolvedValue([{ taskCode: 'DD-1' }]),
      voloGetTask: vi.fn().mockResolvedValue({ taskCode: 'DD-1' }),
      voloCreateTask: vi.fn().mockResolvedValue({ ok: true, id: 't1', taskCode: 'DD-2', url: 'u' }),
      voloUpdateTask: vi.fn().mockResolvedValue({ ok: true }),
      voloMoveTask: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: VOLO_METHODS })

    await dispatcher.dispatch(makeRequest('volo.listBoards'))
    await dispatcher.dispatch(makeRequest('volo.listMembers', { boardId: 'b1' }))
    await dispatcher.dispatch(makeRequest('volo.listTasks', { boardId: 'b1', filter: 'assigned' }))
    await dispatcher.dispatch(makeRequest('volo.getTask', { taskCode: 'DD-1' }))
    await dispatcher.dispatch(
      makeRequest('volo.createTask', { boardId: 'b1', title: 'New', columnId: 'todo' })
    )
    await dispatcher.dispatch(
      makeRequest('volo.updateTask', { boardId: 'b1', taskId: 't1', updates: { title: 'Renamed' } })
    )
    await dispatcher.dispatch(
      makeRequest('volo.moveTask', { boardId: 'b1', taskId: 't1', columnId: 'done' })
    )

    expect(runtime.voloListBoards).toHaveBeenCalled()
    expect(runtime.voloListMembers).toHaveBeenCalledWith('b1')
    expect(runtime.voloListTasks).toHaveBeenCalledWith('b1', 'assigned')
    expect(runtime.voloGetTask).toHaveBeenCalledWith('DD-1')
    expect(runtime.voloCreateTask).toHaveBeenCalledWith({
      boardId: 'b1',
      title: 'New',
      columnId: 'todo',
      description: undefined,
      priority: undefined,
      assigneeId: undefined
    })
    expect(runtime.voloUpdateTask).toHaveBeenCalledWith('b1', 't1', { title: 'Renamed' })
    expect(runtime.voloMoveTask).toHaveBeenCalledWith('b1', 't1', 'done')
  })

  it('allows assigned Volo tasks without a board id', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      voloListTasks: vi.fn().mockResolvedValue([])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: VOLO_METHODS })
    await dispatcher.dispatch(makeRequest('volo.listTasks', { filter: 'assigned' }))
    expect(runtime.voloListTasks).toHaveBeenCalledWith('', 'assigned')
  })
})
