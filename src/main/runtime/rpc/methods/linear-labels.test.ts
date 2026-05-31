import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { LINEAR_METHODS } from './linear'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('linear label RPC contract', () => {
  it('normalizes Linear label RPC payloads through the same contract as IPC', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearListIssueLabels: vi.fn().mockResolvedValue([{ id: 'label-1' }]),
      linearCreateIssueLabel: vi.fn().mockResolvedValue({ ok: true, label: { id: 'label-2' } }),
      linearUpdateIssueLabel: vi.fn().mockResolvedValue({ ok: true, label: { id: 'label-2' } }),
      linearRetireIssueLabel: vi.fn().mockResolvedValue({ ok: true, label: { id: 'label-2' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_METHODS })

    await dispatcher.dispatch(
      makeRequest('linear.listIssueLabels', {
        workspaceId: ' workspace-1 ',
        teamId: ' team-1 ',
        includeArchived: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.createIssueLabel', {
        workspaceId: ' workspace-1 ',
        input: {
          name: ' Bug ',
          color: ' #eb5757 ',
          description: ' Defects ',
          teamId: ' team-1 ',
          parentId: ' parent-1 '
        }
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.updateIssueLabel', {
        id: ' label-2 ',
        workspaceId: ' workspace-1 ',
        input: { name: ' Defect ', color: ' ', description: ' ', parentId: null }
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.retireIssueLabel', { id: ' label-2 ', workspaceId: ' workspace-1 ' })
    )

    expect(runtime.linearListIssueLabels).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      includeArchived: true
    })
    expect(runtime.linearCreateIssueLabel).toHaveBeenCalledWith(
      {
        name: 'Bug',
        color: '#eb5757',
        description: 'Defects',
        teamId: 'team-1',
        parentId: 'parent-1'
      },
      'workspace-1'
    )
    expect(runtime.linearUpdateIssueLabel).toHaveBeenCalledWith(
      'label-2',
      { name: 'Defect', color: undefined, description: undefined, parentId: null },
      'workspace-1'
    )
    expect(runtime.linearRetireIssueLabel).toHaveBeenCalledWith('label-2', 'workspace-1')
  })
})
