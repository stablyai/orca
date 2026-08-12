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
      linearListIssues: vi.fn().mockResolvedValue({ items: [{ id: 'issue-2' }], hasMore: true }),
      linearMcpIssueList: vi.fn().mockResolvedValue({ issues: [], meta: {} }),
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
      makeRequest('linear.listIssues', {
        limit: 5,
        workspaceId: 'workspace-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.listIssues', {
        team: 'ENG',
        assignee: 'me',
        cursor: 'next',
        orderBy: 'updatedAt',
        workspaceId: 'workspace-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.mcpListIssues', {
        limit: 5,
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
        updates: {
          stateId: 'state-1',
          assigneeId: null,
          estimate: 5,
          priority: 2,
          labelIds: ['label-1'],
          projectId: 'project-1'
        }
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.createIssue', {
        parentIssueId: 'issue-3',
        teamId: 'team-1',
        title: 'Child task',
        workspaceId: 'workspace-1',
        projectId: 'project-1'
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
    expect(runtime.linearListIssues).toHaveBeenCalledWith('assigned', 20, 'workspace-1', {
      attributeFilter: undefined
    })
    expect(runtime.linearListIssues).toHaveBeenCalledWith(undefined, 5, 'workspace-1', {
      attributeFilter: undefined
    })
    expect(runtime.linearMcpIssueList).toHaveBeenCalledWith({
      team: 'ENG',
      assignee: 'me',
      cursor: 'next',
      orderBy: 'updatedAt',
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearMcpIssueList).toHaveBeenCalledWith({
      limit: 5,
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearGetIssue).toHaveBeenCalledWith('issue-3', 'workspace-1')
    expect(runtime.linearCreateIssue).toHaveBeenCalledWith(
      'team-1',
      'Fix bug',
      'Details',
      'workspace-1',
      undefined,
      undefined,
      {
        assigneeId: undefined,
        labelIds: undefined,
        priority: undefined,
        stateId: undefined
      }
    )
    expect(runtime.linearCreateIssue).toHaveBeenCalledWith(
      'team-1',
      'Child task',
      undefined,
      'workspace-1',
      'issue-3',
      'project-1',
      {
        assigneeId: undefined,
        labelIds: undefined,
        priority: undefined,
        stateId: undefined
      }
    )
    expect(runtime.linearUpdateIssue).toHaveBeenCalledWith(
      'issue-3',
      {
        stateId: 'state-1',
        assigneeId: null,
        estimate: 5,
        priority: 2,
        labelIds: ['label-1'],
        projectId: 'project-1'
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
      linearGetCustomView: vi.fn().mockResolvedValue({ id: 'view-1' }),
      linearGetProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
      linearListCustomViewIssues: vi.fn().mockResolvedValue({ items: [{ id: 'issue-1' }] }),
      linearListCustomViewProjects: vi.fn().mockResolvedValue({ items: [{ id: 'project-2' }] }),
      linearListCustomViews: vi.fn().mockResolvedValue({ items: [{ id: 'view-1' }] }),
      linearListProjectIssues: vi.fn().mockResolvedValue({ items: [{ id: 'issue-2' }] }),
      linearListTeams: vi.fn().mockResolvedValue([{ id: 'team-1' }]),
      linearListProjects: vi.fn().mockResolvedValue({ items: [{ id: 'project-1' }] }),
      linearCreateProject: vi.fn().mockResolvedValue({ ok: true, project: { id: 'project-3' } }),
      linearTeamStates: vi.fn().mockResolvedValue([{ id: 'state-1' }]),
      linearTeamLabels: vi.fn().mockResolvedValue([{ id: 'label-1' }]),
      linearTeamMembers: vi.fn().mockResolvedValue([{ id: 'member-1' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_METHODS })

    await dispatcher.dispatch(makeRequest('linear.listTeams', { workspaceId: 'all' }))
    await dispatcher.dispatch(
      makeRequest('linear.listProjects', { query: 'roadmap', limit: 5, force: true })
    )
    await dispatcher.dispatch(
      makeRequest('linear.createProject', {
        name: 'Roadmap',
        description: 'Summary',
        content: 'Brief',
        teamIds: ['team-1'],
        workspaceId: 'workspace-1',
        leadId: 'user-1',
        memberIds: ['user-1', 'user-2'],
        labelIds: ['label-1'],
        priority: 2,
        startDate: '2026-07-01',
        targetDate: '2026-08-01'
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.getProject', {
        id: 'project-1',
        workspaceId: 'workspace-1',
        force: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.listProjectIssues', {
        projectId: 'project-1',
        limit: 10,
        workspaceId: 'workspace-1',
        force: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.listCustomViews', {
        model: 'project',
        limit: 10,
        workspaceId: 'workspace-1',
        force: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.getCustomView', {
        viewId: 'view-1',
        model: 'project',
        workspaceId: 'workspace-1',
        force: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.listCustomViewIssues', {
        viewId: 'view-1',
        limit: 10,
        workspaceId: 'workspace-1',
        force: true
      })
    )
    await dispatcher.dispatch(
      makeRequest('linear.listCustomViewProjects', {
        viewId: 'view-2',
        limit: 10,
        workspaceId: 'workspace-1',
        force: true
      })
    )
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
    expect(runtime.linearListProjects).toHaveBeenCalledWith('roadmap', 5, undefined, true)
    expect(runtime.linearCreateProject).toHaveBeenCalledWith(
      {
        name: 'Roadmap',
        description: 'Summary',
        content: 'Brief',
        teamIds: ['team-1'],
        leadId: 'user-1',
        memberIds: ['user-1', 'user-2'],
        labelIds: ['label-1'],
        priority: 2,
        startDate: '2026-07-01',
        targetDate: '2026-08-01'
      },
      'workspace-1'
    )
    expect(runtime.linearGetProject).toHaveBeenCalledWith('project-1', 'workspace-1', true)
    expect(runtime.linearListProjectIssues).toHaveBeenCalledWith(
      'project-1',
      10,
      'workspace-1',
      true
    )
    expect(runtime.linearListCustomViews).toHaveBeenCalledWith('project', 10, 'workspace-1', true)
    expect(runtime.linearGetCustomView).toHaveBeenCalledWith(
      'view-1',
      'project',
      'workspace-1',
      true
    )
    expect(runtime.linearListCustomViewIssues).toHaveBeenCalledWith(
      'view-1',
      10,
      'workspace-1',
      true
    )
    expect(runtime.linearListCustomViewProjects).toHaveBeenCalledWith(
      'view-2',
      10,
      'workspace-1',
      true
    )
    expect(runtime.linearTeamStates).toHaveBeenCalledWith('team-1', 'workspace-1')
    expect(runtime.linearTeamLabels).toHaveBeenCalledWith('team-1', 'workspace-1')
    expect(runtime.linearTeamMembers).toHaveBeenCalledWith('team-1', 'workspace-1')
  })
})
