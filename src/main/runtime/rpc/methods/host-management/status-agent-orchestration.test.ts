import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { STATUS_METHODS } from './status'

describe('status.agentOrchestration', () => {
  it("hands a paired client the host's parent/child map so its child chats nest", async () => {
    const runtime = new OrcaRuntimeService(null)
    const byPaneKey = {
      'chat-tab:child-session': {
        taskId: 'task-1',
        dispatchId: 'dispatch-1',
        parentPaneKey: 'chat-tab:parent-session'
      }
    }
    vi.spyOn(runtime, 'agentOrchestrationByPaneKey').mockReturnValue(byPaneKey)
    const dispatcher = new RpcDispatcher({ runtime, methods: STATUS_METHODS })

    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'local',
      method: 'status.agentOrchestration'
    })

    expect(response).toMatchObject({ ok: true, result: { byPaneKey } })
  })

  it('answers an empty map while the host has no orchestration', async () => {
    const runtime = new OrcaRuntimeService(null)
    vi.spyOn(runtime, 'agentOrchestrationByPaneKey').mockReturnValue(undefined)
    const dispatcher = new RpcDispatcher({ runtime, methods: STATUS_METHODS })

    const response = await dispatcher.dispatch({
      id: 'req-2',
      authToken: 'local',
      method: 'status.agentOrchestration'
    })

    expect(response).toMatchObject({ ok: true, result: { byPaneKey: {} } })
  })
})
