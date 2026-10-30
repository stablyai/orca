import '../unused-default-rpc-methods.test-fixture'
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
      jiraReadStatus: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      jiraTestConnection: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      jiraConnect: vi.fn().mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } }),
      jiraSelectSite: vi.fn().mockResolvedValue({ connected: true, viewer: null }),
      jiraDisconnect: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })

    await dispatcher.dispatch(makeRequest('jira.status'))
    await dispatcher.dispatch(makeRequest('jira.readStatus'))
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
    expect(runtime.jiraReadStatus).toHaveBeenCalled()
    expect(runtime.jiraTestConnection).toHaveBeenCalled()
    expect(runtime.jiraConnect).toHaveBeenCalledWith({
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      apiToken: 'token'
    })
    expect(runtime.jiraSelectSite).toHaveBeenCalledWith('site-1')
    expect(runtime.jiraDisconnect).toHaveBeenCalled()
  })

  it('routes Jira issue queries and mutations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraSearchIssues: vi.fn().mockResolvedValue([{ key: 'ABC-1' }]),
      jiraListIssues: vi.fn().mockResolvedValue([{ key: 'ABC-2' }]),
      jiraGetIssue: vi.fn().mockResolvedValue({ key: 'ABC-3' }),
      jiraLookupIssueSummary: vi.fn().mockResolvedValue({ key: 'ABC-3' }),
      jiraCreateIssue: vi.fn().mockResolvedValue({ ok: true, key: 'ABC-4' }),
      jiraUpdateIssue: vi.fn().mockResolvedValue({ ok: true }),
      jiraAddIssueComment: vi.fn().mockResolvedValue({ ok: true, id: 'comment-1' }),
      jiraIssueComments: vi.fn().mockResolvedValue([{ id: 'comment-2' }])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })
    const summaryController = new AbortController()

    await dispatcher.dispatch(
      makeRequest('jira.searchIssues', { jql: 'project = ABC', limit: 30, siteId: 'all' })
    )
    await dispatcher.dispatch(
      makeRequest('jira.listIssues', { filter: 'assigned', limit: 20, siteId: 'site-1' })
    )
    await dispatcher.dispatch(makeRequest('jira.getIssue', { key: 'ABC-3', siteId: 'site-1' }))
    await dispatcher.dispatch(
      makeRequest('jira.lookupIssueSummary', { key: 'ABC-3', siteId: 'site-1' }),
      { signal: summaryController.signal }
    )
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
          assigneeAccountId: null,
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

    // Why: this dispatch carries no cancellation signal, so search runs unbounded by the caller.
    expect(runtime.jiraSearchIssues).toHaveBeenCalledWith(
      'project = ABC',
      30,
      'all',
      undefined,
      undefined
    )
    expect(runtime.jiraListIssues).toHaveBeenCalledWith(
      'assigned',
      20,
      'site-1',
      undefined,
      undefined
    )
    expect(runtime.jiraGetIssue).toHaveBeenCalledWith('ABC-3', 'site-1', undefined, undefined)
    expect(runtime.jiraLookupIssueSummary).toHaveBeenCalledWith(
      'ABC-3',
      'site-1',
      summaryController.signal
    )
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
        assigneeAccountId: null,
        priorityId: '2',
        labels: ['bug'],
        transitionId: '31'
      },
      'site-1'
    )
    expect(runtime.jiraAddIssueComment).toHaveBeenCalledWith('ABC-3', 'Looks good', 'site-1')
    expect(runtime.jiraIssueComments).toHaveBeenCalledWith('ABC-3', 'site-1', undefined, undefined)
  })

  it('passes verified read requests and atomic label operations through RPC', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraGetIssue: vi.fn().mockResolvedValue(null),
      jiraIssueComments: vi.fn().mockResolvedValue([]),
      jiraUpdateIssue: vi.fn().mockResolvedValue({ ok: true })
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This dispatcher test only invokes the three methods implemented by the fixture.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: JIRA_METHODS
    })
    await dispatcher.dispatch(
      makeRequest('jira.getIssue', {
        key: 'ABC-1',
        siteId: 'site-1',
        strict: true,
        mediaFormat: 'reference'
      })
    )
    await dispatcher.dispatch(
      makeRequest('jira.issueComments', {
        key: 'ABC-1',
        siteId: 'site-1',
        strict: true,
        mediaFormat: 'reference'
      })
    )
    await dispatcher.dispatch(
      makeRequest('jira.updateIssue', {
        key: 'ABC-1',
        siteId: 'site-1',
        updates: { labelOperations: { add: ['bug'] } }
      })
    )
    expect(runtime.jiraGetIssue).toHaveBeenCalledWith('ABC-1', 'site-1', true, 'reference')
    expect(runtime.jiraIssueComments).toHaveBeenCalledWith('ABC-1', 'site-1', true, 'reference')
    expect(runtime.jiraUpdateIssue).toHaveBeenCalledWith(
      'ABC-1',
      { labelOperations: { add: ['bug'] } },
      'site-1'
    )
    const conflict = await dispatcher.dispatch(
      makeRequest('jira.updateIssue', {
        key: 'ABC-1',
        updates: { labels: ['replace'], labelOperations: { add: ['bug'] } }
      })
    )
    expect(conflict).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.jiraUpdateIssue).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit site for isolated Jira summary reads', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraLookupIssueSummary: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })

    await expect(
      dispatcher.dispatch(makeRequest('jira.lookupIssueSummary', { key: 'ABC-3' }))
    ).resolves.toMatchObject({ ok: false })
    expect(runtime.jiraLookupIssueSummary).not.toHaveBeenCalled()
  })

  it('streams Jira image-bearing payloads in bounded JSON chunks', async () => {
    const description = `![shot](data:image/png;base64,${'a'.repeat(300_000)})`
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraGetIssue: vi.fn().mockResolvedValue({ key: 'ABC-3', description })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('jira.getIssueStream', { key: 'ABC-3', siteId: 'site-1' }),
      (response) => replies.push(response)
    )

    const messages = replies.map(
      (response) => (JSON.parse(response) as { result: { type: string; content?: string } }).result
    )
    expect(messages.at(-1)).toEqual({ type: 'end' })
    expect(messages.filter((message) => message.type === 'chunk')).toHaveLength(2)
    const payload = messages.map((message) => message.content ?? '').join('')
    expect(JSON.parse(payload)).toEqual({ key: 'ABC-3', description })
  })

  it('routes Jira metadata requests to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      jiraListProjects: vi.fn().mockResolvedValue([{ id: 'project-1' }]),
      jiraListIssueTypes: vi.fn().mockResolvedValue([{ id: 'type-1' }]),
      jiraListCreateFields: vi.fn().mockResolvedValue([{ key: 'customfield_10010' }]),
      jiraListPriorities: vi.fn().mockResolvedValue([{ id: 'priority-1' }]),
      jiraListAssignableUsers: vi.fn().mockResolvedValue([{ accountId: 'user-1' }]),
      jiraSearchUsers: vi.fn().mockResolvedValue([{ accountId: 'user-2' }]),
      jiraListTransitions: vi.fn().mockResolvedValue([{ id: 'transition-1' }]),
      jiraGetProjectStatusOrder: vi.fn().mockResolvedValue({
        statusIdsByColumn: [['status-1']]
      })
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
    await dispatcher.dispatch(makeRequest('jira.searchUsers', { query: 'Grace', siteId: 'site-1' }))
    await dispatcher.dispatch(
      makeRequest('jira.listTransitions', { key: 'ABC-3', siteId: 'site-1', strict: true })
    )
    await dispatcher.dispatch(
      makeRequest('jira.getProjectStatusOrder', { projectKey: 'ALP', siteId: 'site-1' })
    )

    expect(runtime.jiraListProjects).toHaveBeenCalledWith('all', undefined)
    expect(runtime.jiraListIssueTypes).toHaveBeenCalledWith('project-1', 'site-1', undefined)
    expect(runtime.jiraListCreateFields).toHaveBeenCalledWith(
      'project-1',
      'type-1',
      'site-1',
      undefined
    )
    expect(runtime.jiraListPriorities).toHaveBeenCalledWith('site-1', undefined)
    expect(runtime.jiraListAssignableUsers).toHaveBeenCalledWith(
      'ABC-3',
      'Ada',
      'site-1',
      undefined
    )
    expect(runtime.jiraSearchUsers).toHaveBeenCalledWith('Grace', 'site-1')
    expect(runtime.jiraListTransitions).toHaveBeenCalledWith('ABC-3', 'site-1', true)
    expect(runtime.jiraGetProjectStatusOrder).toHaveBeenCalledWith('ALP', 'site-1')
  })
})

it('forwards strict reads and optional status filters while accepting older requests', async () => {
  const jiraListIssues = vi.fn().mockResolvedValue([])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the runtime identity and list method are invoked by these requests.
  const runtime = { getRuntimeId: () => 'host-a', jiraListIssues } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })
  expect(
    await dispatcher.dispatch(
      makeRequest('jira.listIssues', {
        filter: 'all',
        siteId: 'site-1',
        strict: true,
        filters: { statuses: ['In Progress'] }
      })
    )
  ).toMatchObject({ ok: true })
  expect(jiraListIssues).toHaveBeenLastCalledWith('all', undefined, 'site-1', true, {
    statuses: ['In Progress']
  })
  await dispatcher.dispatch(makeRequest('jira.listIssues', { filter: 'all' }))
  expect(jiraListIssues).toHaveBeenLastCalledWith('all', undefined, undefined, undefined, undefined)
})

describe('Jira title generation RPC', () => {
  it('binds generation and stop to the authenticated device across one-shot sockets', async () => {
    const generate = vi.fn().mockResolvedValue({ success: true, summary: 'Title' })
    const cancel = vi.fn().mockReturnValue({ ok: true })
    const stub = {
      getRuntimeId: () => 'test-runtime',
      jiraGenerateIssueSummary: generate,
      jiraCancelGenerateIssueSummary: cancel
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods only use the three supplied runtime operations.
    const runtime = stub as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })
    const args = { siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1', description: 'Draft' }
    const abort = new AbortController()
    await dispatcher.dispatch(makeRequest('jira.generateIssueSummary', args), {
      connectionId: 'connection-1',
      pairedDeviceId: 'device-1',
      signal: abort.signal
    })
    await dispatcher.dispatch(makeRequest('jira.cancelGenerateIssueSummary', args), {
      connectionId: 'connection-2',
      pairedDeviceId: 'device-1'
    })
    expect(generate).toHaveBeenCalledWith(args, 'device:device-1', abort.signal)
    await dispatcher.dispatch(makeRequest('jira.cancelGenerateIssueSummary', args), {
      connectionId: 'connection-3',
      pairedDeviceId: 'device-2'
    })
    expect(cancel).toHaveBeenLastCalledWith(
      { siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1' },
      'device:device-2'
    )
    expect(cancel).toHaveBeenCalledWith(
      { siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1' },
      'device:device-1'
    )
  })

  it('rejects an unscoped request before generation starts', async () => {
    const generate = vi.fn()
    const stub = { getRuntimeId: () => 'test-runtime', jiraGenerateIssueSummary: generate }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: schema rejection never accesses other runtime operations.
    const runtime = stub as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JIRA_METHODS })
    const reply = await dispatcher.dispatch(
      makeRequest('jira.generateIssueSummary', { description: 'Draft' })
    )
    expect(reply.ok).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })
})
