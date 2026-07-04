import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { JIRA_METHODS } from './jira'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('jira RPC methods', () => {
  it('routes Jira account methods to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraStatus: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      jiraTestConnection: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      jiraConnect: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      jiraSelectSite: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      jiraDisconnect: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })

    await dispatcher.dispatch(makeRequest('jira.status'))
    await dispatcher.dispatch(makeRequest('jira.testConnection'))
    await dispatcher.dispatch(
      makeRequest('jira.connect', {
        siteUrl: 'https://example.atlassian.net',
        email: 'ada@example.com',
        apiToken: 'token'
      })
    )
    await dispatcher.dispatch(makeRequest('jira.selectSite', { siteId: 'site-1' }))
    await dispatcher.dispatch(makeRequest('jira.disconnect'))

    expect(runtime.jiraStatus).toHaveBeenCalled()
    expect(runtime.jiraTestConnection).toHaveBeenCalled()
    expect(runtime.jiraConnect).toHaveBeenCalledWith({
      deploymentType: 'cloud',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      apiToken: 'token'
    })
    expect(runtime.jiraSelectSite).toHaveBeenCalledWith('site-1')
    expect(runtime.jiraDisconnect).toHaveBeenCalled()
  })

  it('routes Jira Server connect payloads to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraConnect: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })

    await dispatcher.dispatch(
      makeRequest('jira.connect', {
        deploymentType: 'server',
        authMode: 'basic',
        siteUrl: 'https://jira.example.internal',
        username: 'ada',
        passwordOrToken: 'secret'
      })
    )
    await dispatcher.dispatch(
      makeRequest('jira.connect', {
        deploymentType: 'server',
        authMode: 'bearer',
        siteUrl: 'https://jira.example.internal',
        bearerToken: 'pat-secret'
      })
    )

    expect(runtime.jiraConnect).toHaveBeenNthCalledWith(1, {
      deploymentType: 'server',
      authMode: 'basic',
      siteUrl: 'https://jira.example.internal',
      username: 'ada',
      passwordOrToken: 'secret'
    })
    expect(runtime.jiraConnect).toHaveBeenNthCalledWith(2, {
      deploymentType: 'server',
      authMode: 'bearer',
      siteUrl: 'https://jira.example.internal',
      bearerToken: 'pat-secret'
    })
  })

  it('rejects mixed Jira connect auth payloads', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraConnect: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('jira.connect', {
        deploymentType: 'server',
        authMode: 'bearer',
        siteUrl: 'https://jira.example.internal',
        username: 'ada',
        bearerToken: 'pat-secret'
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(runtime.jiraConnect).not.toHaveBeenCalled()
  })

  it('rejects mixed Jira assignee identifier issue updates', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraUpdateIssue: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('jira.updateIssue', {
        key: 'ABC-3',
        updates: {
          assigneeUserId: 'ada',
          assigneeAccountId: 'account-1'
        }
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(runtime.jiraUpdateIssue).not.toHaveBeenCalled()
  })

  it('routes Jira issue queries and mutations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraSearchIssues: vi.fn().mockResolvedValue([{ key: 'ABC-1' }]),
      jiraListIssues: vi.fn().mockResolvedValue([{ key: 'ABC-2' }]),
      jiraGetIssue: vi.fn().mockResolvedValue({ key: 'ABC-3' }),
      jiraCreateIssue: vi.fn().mockResolvedValue({ ok: true, key: 'ABC-4' }),
      jiraUpdateIssue: vi.fn().mockResolvedValue({ ok: true }),
      jiraAddIssueComment: vi.fn().mockResolvedValue({ ok: true, id: 'comment-1' }),
      jiraIssueComments: vi.fn().mockResolvedValue([{ id: 'comment-2' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })

    await dispatcher.dispatch(
      makeRequest('jira.searchIssues', { jql: 'project = ABC', limit: 30, siteId: 'all' })
    )
    await dispatcher.dispatch(
      makeRequest('jira.listIssues', { filter: 'assigned', limit: 20, siteId: 'site-1' })
    )
    await dispatcher.dispatch(makeRequest('jira.getIssue', { key: 'ABC-3', siteId: 'site-1' }))
    await dispatcher.dispatch(
      makeRequest('jira.createIssue', {
        siteId: 'site-1',
        projectId: 'project-1',
        issueTypeId: 'type-1',
        title: 'Fix bug',
        description: 'Details',
        customFields: { customfield_10010: { id: 'option-1' } }
      })
    )
    await dispatcher.dispatch(
      makeRequest('jira.updateIssue', {
        key: 'ABC-3',
        siteId: 'site-1',
        updates: {
          title: 'Fixed title',
          assigneeUserId: null,
          priorityId: '2',
          labels: ['bug'],
          transitionId: '31'
        }
      })
    )
    await dispatcher.dispatch(
      makeRequest('jira.addIssueComment', { key: 'ABC-3', body: 'Looks good', siteId: 'site-1' })
    )
    await dispatcher.dispatch(makeRequest('jira.issueComments', { key: 'ABC-3', siteId: 'site-1' }))

    expect(runtime.jiraSearchIssues).toHaveBeenCalledWith('project = ABC', 30, 'all')
    expect(runtime.jiraListIssues).toHaveBeenCalledWith('assigned', 20, 'site-1')
    expect(runtime.jiraGetIssue).toHaveBeenCalledWith('ABC-3', 'site-1')
    expect(runtime.jiraCreateIssue).toHaveBeenCalledWith({
      siteId: 'site-1',
      projectId: 'project-1',
      issueTypeId: 'type-1',
      title: 'Fix bug',
      description: 'Details',
      customFields: { customfield_10010: { id: 'option-1' } }
    })
    expect(runtime.jiraUpdateIssue).toHaveBeenCalledWith(
      'ABC-3',
      {
        title: 'Fixed title',
        assigneeUserId: null,
        priorityId: '2',
        labels: ['bug'],
        transitionId: '31'
      },
      'site-1'
    )
    expect(runtime.jiraAddIssueComment).toHaveBeenCalledWith('ABC-3', 'Looks good', 'site-1')
    expect(runtime.jiraIssueComments).toHaveBeenCalledWith('ABC-3', 'site-1')
  })

  it('routes Jira metadata requests to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraListProjects: vi.fn().mockResolvedValue([{ id: 'project-1' }]),
      jiraListIssueTypes: vi.fn().mockResolvedValue([{ id: 'type-1' }]),
      jiraListCreateFields: vi.fn().mockResolvedValue([{ key: 'customfield_10010' }]),
      jiraListPriorities: vi.fn().mockResolvedValue([{ id: 'priority-1' }]),
      jiraListAssignableUsers: vi.fn().mockResolvedValue([{ accountId: 'user-1' }]),
      jiraListTransitions: vi.fn().mockResolvedValue([{ id: 'transition-1' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })

    await dispatcher.dispatch(makeRequest('jira.listProjects', { siteId: 'all' }))
    await dispatcher.dispatch(
      makeRequest('jira.listIssueTypes', { projectIdOrKey: 'project-1', siteId: 'site-1' })
    )
    await dispatcher.dispatch(
      makeRequest('jira.listCreateFields', {
        projectIdOrKey: 'project-1',
        issueTypeId: 'type-1',
        siteId: 'site-1'
      })
    )
    await dispatcher.dispatch(makeRequest('jira.listPriorities', { siteId: 'site-1' }))
    await dispatcher.dispatch(
      makeRequest('jira.listAssignableUsers', {
        key: 'ABC-3',
        query: 'Ada',
        siteId: 'site-1'
      })
    )
    await dispatcher.dispatch(
      makeRequest('jira.listTransitions', { key: 'ABC-3', siteId: 'site-1' })
    )

    expect(runtime.jiraListProjects).toHaveBeenCalledWith('all')
    expect(runtime.jiraListIssueTypes).toHaveBeenCalledWith('project-1', 'site-1')
    expect(runtime.jiraListCreateFields).toHaveBeenCalledWith('project-1', 'type-1', 'site-1')
    expect(runtime.jiraListPriorities).toHaveBeenCalledWith('site-1')
    expect(runtime.jiraListAssignableUsers).toHaveBeenCalledWith('ABC-3', 'Ada', 'site-1')
    expect(runtime.jiraListTransitions).toHaveBeenCalledWith('ABC-3', 'site-1')
  })
})
