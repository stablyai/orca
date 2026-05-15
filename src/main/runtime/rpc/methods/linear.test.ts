import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { LINEAR_METHODS } from './linear'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('linear RPC methods', () => {
  it('routes Linear account methods to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearStatus: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      linearTestConnection: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      linearConnect: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      linearSelectWorkspace: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      linearDisconnect: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_METHODS })

    await dispatcher.dispatch(makeRequest('linear.status'))
    await dispatcher.dispatch(makeRequest('linear.testConnection'))
    await dispatcher.dispatch(makeRequest('linear.connect', { apiKey: 'lin_api_key' }))
    await dispatcher.dispatch(makeRequest('linear.selectWorkspace', { workspaceId: 'workspace-1' }))
    await dispatcher.dispatch(makeRequest('linear.disconnect'))

    expect(runtime.linearStatus).toHaveBeenCalled()
    expect(runtime.linearTestConnection).toHaveBeenCalled()
    expect(runtime.linearConnect).toHaveBeenCalledWith('lin_api_key')
    expect(runtime.linearSelectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(runtime.linearDisconnect).toHaveBeenCalled()
  })

  it('routes Linear issue queries and mutations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearSearchIssues: vi.fn().mockResolvedValue([{ id: 'issue-1' }]),
      linearListIssues: vi.fn().mockResolvedValue([{ id: 'issue-2' }]),
      linearGetIssue: vi.fn().mockResolvedValue({ id: 'issue-3' }),
      linearCreateIssue: vi.fn().mockResolvedValue({ ok: true, id: 'issue-4' }),
      linearUpdateIssue: vi.fn().mockResolvedValue({ ok: true }),
      linearAddIssueComment: vi.fn().mockResolvedValue({ ok: true, id: 'comment-1' }),
      linearIssueComments: vi.fn().mockResolvedValue([{ id: 'comment-2' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_METHODS })

    await dispatcher.dispatch(
      makeRequest('linear.searchIssues', { query: 'bug', limit: 30, workspaceId: 'all' })
    )
    await dispatcher.dispatch(
      makeRequest('linear.listIssues', {
        filter: 'assigned',
        limit: 20,
        workspaceId: 'workspace-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.getIssue', { id: 'issue-3', workspaceId: 'workspace-1' })
    )
    await dispatcher.dispatch(
      makeRequest('linear.createIssue', {
        teamId: 'team-1',
        title: 'Fix bug',
        description: 'Details',
        workspaceId: 'workspace-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.updateIssue', {
        id: 'issue-3',
        workspaceId: 'workspace-1',
        updates: { stateId: 'state-1', assigneeId: null, priority: 2, labelIds: ['label-1'] }
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.addIssueComment', {
        issueId: 'issue-3',
        body: 'Looks good',
        workspaceId: 'workspace-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.issueComments', { issueId: 'issue-3', workspaceId: 'workspace-1' })
    )

    expect(runtime.linearSearchIssues).toHaveBeenCalledWith('bug', 30, 'all')
    expect(runtime.linearListIssues).toHaveBeenCalledWith('assigned', 20, 'workspace-1')
    expect(runtime.linearGetIssue).toHaveBeenCalledWith('issue-3', 'workspace-1')
    expect(runtime.linearCreateIssue).toHaveBeenCalledWith(
      'team-1',
      'Fix bug',
      'Details',
      'workspace-1'
    )
    expect(runtime.linearUpdateIssue).toHaveBeenCalledWith(
      'issue-3',
      {
        stateId: 'state-1',
        assigneeId: null,
        priority: 2,
        labelIds: ['label-1']
      },
      'workspace-1'
    )
    expect(runtime.linearAddIssueComment).toHaveBeenCalledWith(
      'issue-3',
      'Looks good',
      'workspace-1'
    )
    expect(runtime.linearIssueComments).toHaveBeenCalledWith('issue-3', 'workspace-1')
  })

  it('routes Linear metadata requests to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearListTeams: vi.fn().mockResolvedValue([{ id: 'team-1' }]),
      linearTeamStates: vi.fn().mockResolvedValue([{ id: 'state-1' }]),
      linearTeamLabels: vi.fn().mockResolvedValue([{ id: 'label-1' }]),
      linearTeamMembers: vi.fn().mockResolvedValue([{ id: 'member-1' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_METHODS })

    await dispatcher.dispatch(makeRequest('linear.listTeams', { workspaceId: 'all' }))
    await dispatcher.dispatch(
      makeRequest('linear.teamStates', { teamId: 'team-1', workspaceId: 'workspace-1' })
    )
    await dispatcher.dispatch(
      makeRequest('linear.teamLabels', { teamId: 'team-1', workspaceId: 'workspace-1' })
    )
    await dispatcher.dispatch(
      makeRequest('linear.teamMembers', { teamId: 'team-1', workspaceId: 'workspace-1' })
    )

    expect(runtime.linearListTeams).toHaveBeenCalledWith('all')
    expect(runtime.linearTeamStates).toHaveBeenCalledWith('team-1', 'workspace-1')
    expect(runtime.linearTeamLabels).toHaveBeenCalledWith('team-1', 'workspace-1')
    expect(runtime.linearTeamMembers).toHaveBeenCalledWith('team-1', 'workspace-1')
  })
})
