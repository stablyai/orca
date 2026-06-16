import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { LinearWriteFailure } from '../../../linear/issues'
import { sanitizeLinearErrorMessage } from '../../../linear/issue-context-errors'
import { LINEAR_AGENT_ACCESS_METHODS } from './linear-agent-access'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('Linear agent access RPC methods', () => {
  it('routes agent write methods to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearIssueSetState: vi.fn().mockResolvedValue({ ok: true }),
      linearTeamListForAgents: vi.fn().mockResolvedValue({ ok: true }),
      linearTeamMembersForAgents: vi.fn().mockResolvedValue({ ok: true }),
      linearTeamStatesForAgents: vi.fn().mockResolvedValue({ ok: true }),
      linearTeamLabelsForAgents: vi.fn().mockResolvedValue({ ok: true }),
      linearIssueListForAgents: vi.fn().mockResolvedValue({ ok: true }),
      linearProjectListForAgents: vi.fn().mockResolvedValue({ ok: true }),
      linearIssueUpdateTask: vi.fn().mockResolvedValue({ ok: true }),
      linearIssueAddComment: vi.fn().mockResolvedValue({ ok: true }),
      linearIssueAttachLink: vi.fn().mockResolvedValue({ ok: true }),
      linearIssueCreate: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })

    const setStateResponse = await dispatcher.dispatch(
      makeRequest('linear.issueSetState', {
        input: 'ENG-1',
        to: 'In Review',
        workspaceId: 'workspace-1'
      })
    )
    const teamListResponse = await dispatcher.dispatch(
      makeRequest('linear.agentTeamList', { workspaceId: 'all' })
    )
    const teamMembersResponse = await dispatcher.dispatch(
      makeRequest('linear.agentTeamMembers', { teamInput: 'ENG', workspaceId: 'workspace-1' })
    )
    const teamStatesResponse = await dispatcher.dispatch(
      makeRequest('linear.agentTeamStates', { teamInput: 'ENG', workspaceId: 'workspace-1' })
    )
    const teamLabelsResponse = await dispatcher.dispatch(
      makeRequest('linear.agentTeamLabels', { teamInput: 'ENG', workspaceId: 'workspace-1' })
    )
    const issueListResponse = await dispatcher.dispatch(
      makeRequest('linear.agentIssueList', {
        filter: 'open',
        teamInput: 'ENG',
        limit: 10,
        workspaceId: 'workspace-1'
      })
    )
    const projectListResponse = await dispatcher.dispatch(
      makeRequest('linear.agentProjectList', {
        query: 'launch',
        limit: 10,
        workspaceId: 'all'
      })
    )
    const taskUpdateResponse = await dispatcher.dispatch(
      makeRequest('linear.issueUpdateTask', {
        input: 'ENG-1',
        operation: 'dueDate',
        dueDate: '2026-06-30',
        workspaceId: 'workspace-1'
      })
    )
    const commentResponse = await dispatcher.dispatch(
      makeRequest('linear.issueAddComment', {
        input: 'ENG-1',
        body: 'Done',
        replyTo: 'comment-1',
        writeId: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'workspace-1'
      })
    )
    const attachResponse = await dispatcher.dispatch(
      makeRequest('linear.issueAttachLink', {
        input: 'ENG-1',
        url: 'https://example.com/review/1',
        title: 'Review',
        writeId: '22222222-2222-4222-8222-222222222222',
        workspaceId: 'workspace-1'
      })
    )
    const createResponse = await dispatcher.dispatch(
      makeRequest('linear.issueCreate', {
        title: 'Follow up',
        body: 'Details',
        teamInput: 'ENG',
        projectInput: 'project-1',
        priority: 2,
        parentInput: 'ENG-1',
        writeId: '33333333-3333-4333-8333-333333333333',
        workspaceId: 'workspace-1'
      })
    )

    expect(setStateResponse.ok).toBe(true)
    expect(teamListResponse.ok).toBe(true)
    expect(teamMembersResponse.ok).toBe(true)
    expect(teamStatesResponse.ok).toBe(true)
    expect(teamLabelsResponse.ok).toBe(true)
    expect(issueListResponse.ok).toBe(true)
    expect(projectListResponse.ok).toBe(true)
    expect(taskUpdateResponse.ok).toBe(true)
    expect(commentResponse.ok).toBe(true)
    expect(attachResponse.ok).toBe(true)
    expect(createResponse.ok).toBe(true)
    expect(runtime.linearIssueSetState).toHaveBeenCalledWith({
      input: 'ENG-1',
      to: 'In Review',
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearTeamListForAgents).toHaveBeenCalledWith({ workspaceId: 'all' })
    expect(runtime.linearTeamMembersForAgents).toHaveBeenCalledWith({
      teamInput: 'ENG',
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearTeamStatesForAgents).toHaveBeenCalledWith({
      teamInput: 'ENG',
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearTeamLabelsForAgents).toHaveBeenCalledWith({
      teamInput: 'ENG',
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearIssueListForAgents).toHaveBeenCalledWith({
      filter: 'open',
      teamInput: 'ENG',
      limit: 10,
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearProjectListForAgents).toHaveBeenCalledWith({
      query: 'launch',
      limit: 10,
      workspaceId: 'all'
    })
    expect(runtime.linearIssueUpdateTask).toHaveBeenCalledWith({
      input: 'ENG-1',
      operation: 'dueDate',
      dueDate: '2026-06-30',
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearIssueAddComment).toHaveBeenCalledWith({
      input: 'ENG-1',
      body: 'Done',
      replyTo: 'comment-1',
      writeId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearIssueAttachLink).toHaveBeenCalledWith({
      input: 'ENG-1',
      url: 'https://example.com/review/1',
      title: 'Review',
      writeId: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'workspace-1'
    })
    expect(runtime.linearIssueCreate).toHaveBeenCalledWith({
      title: 'Follow up',
      body: 'Details',
      teamInput: 'ENG',
      projectInput: 'project-1',
      priority: 2,
      parentInput: 'ENG-1',
      writeId: '33333333-3333-4333-8333-333333333333',
      workspaceId: 'workspace-1'
    })
  })

  it('rejects malformed write ids before the runtime is called', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearIssueAddComment: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('linear.issueAddComment', {
        input: 'ENG-1',
        body: 'Done',
        writeId: 'not-a-uuid'
      })
    )

    expect(response.ok).toBe(false)
    expect(response.ok === false ? response.error.code : '').toBe('linear_invalid_write_id')
    expect(runtime.linearIssueAddComment).not.toHaveBeenCalled()
  })

  it('rejects workspace all for direct write RPC calls', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearIssueSetState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('linear.issueSetState', {
        input: 'ENG-1',
        to: 'In Review',
        workspaceId: 'all'
      })
    )

    expect(response.ok).toBe(false)
    expect(response.ok === false ? response.error.message : '').toContain(
      '--workspace all is not valid for Linear writes'
    )
    expect(runtime.linearIssueSetState).not.toHaveBeenCalled()
  })

  it('rejects workspace all for non-list team discovery RPC calls', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearTeamMembersForAgents: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('linear.agentTeamMembers', {
        teamInput: 'ENG',
        workspaceId: 'all'
      })
    )

    expect(response.ok).toBe(false)
    expect(response.ok === false ? response.error.message : '').toContain(
      '--workspace all is only valid for team list'
    )
    expect(runtime.linearTeamMembersForAgents).not.toHaveBeenCalled()
  })

  it('rejects invalid due dates before the runtime is called', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      linearIssueUpdateTask: vi.fn(),
      linearIssueCreate: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })

    const updateResponse = await dispatcher.dispatch(
      makeRequest('linear.issueUpdateTask', {
        input: 'ENG-1',
        operation: 'dueDate',
        dueDate: 'tomorrow',
        workspaceId: 'workspace-1'
      })
    )
    const createResponse = await dispatcher.dispatch(
      makeRequest('linear.issueCreate', {
        title: 'Follow up',
        dueDate: 'June 30',
        workspaceId: 'workspace-1'
      })
    )

    expect(updateResponse.ok).toBe(false)
    expect(updateResponse.ok === false ? updateResponse.error.message : '').toContain(
      'Linear due dates must use YYYY-MM-DD'
    )
    expect(createResponse.ok).toBe(false)
    expect(createResponse.ok === false ? createResponse.error.message : '').toContain(
      'Linear due dates must use YYYY-MM-DD'
    )
    expect(runtime.linearIssueUpdateTask).not.toHaveBeenCalled()
    expect(runtime.linearIssueCreate).not.toHaveBeenCalled()
  })
})

type LinearWriteRunner = {
  runLinearAgentWrite<T>(
    write: (signal: AbortSignal) => Promise<T>,
    unconfirmed: (cause?: string) => Error
  ): Promise<T>
}

type LinearUnconfirmedBuilder = {
  linearCreateStyleUnconfirmed(
    verb: 'comment' | 'attach' | 'create',
    writeId: string,
    target: unknown,
    extra?: unknown
  ): Error & { data?: { cause?: string; nextSteps?: string[] } }
  resolveLinearAgentState(input: string, states: unknown[]): unknown | null
  linearCreatedIssueMatchesIntent(issue: unknown, intent: unknown): boolean
  notifyLinearLinkedIssueUpdated(workspaceId: string, identifier: string): Promise<void>
  listResolvedWorktrees(): Promise<unknown[]>
}

type LinearRetryLookupTester = {
  getMatchingLinearCommentWrite(
    writeId: string,
    issueId: string,
    parentId: string | null,
    workspaceId: string,
    required: boolean
  ): Promise<unknown | null>
  getMatchingLinearAttachmentWrite(
    writeId: string,
    issueId: string,
    workspaceId: string,
    required: boolean
  ): Promise<unknown | null>
  getMatchingLinearCreatedIssue(
    writeId: string,
    teamId: string,
    parentId: string | null,
    workspaceId: string,
    required: boolean,
    intent?: unknown
  ): Promise<unknown | null>
  refetchLinearCommentAfterDuplicate(
    writeId: string,
    issueId: string,
    parentId: string | null,
    workspaceId: string,
    unconfirmed: () => Error
  ): Promise<unknown>
  readLinearWriteLookup(lookup: () => Promise<unknown>): Promise<unknown>
}

describe('Linear agent write recovery helpers', () => {
  it('keeps stable write failure codes while preserving the Linear provider message', async () => {
    const runtime = new OrcaRuntimeService()
    const runner = runtime as unknown as LinearWriteRunner

    await expect(
      runner.runLinearAgentWrite(
        async () => {
          throw new LinearWriteFailure(
            'failed',
            'Linear rejected the state transition because the issue is archived.'
          )
        },
        () => Object.assign(new Error('should not be used'), { code: 'linear_write_unconfirmed' })
      )
    ).rejects.toMatchObject({
      code: 'linear_write_failed',
      message: 'Linear rejected the state transition because the issue is archived.'
    })
  })

  it('keeps pinned retry guidance for unconfirmed writes while adding sanitized cause text', async () => {
    const runtime = new OrcaRuntimeService()
    const runner = runtime as unknown as LinearWriteRunner
    const builder = runtime as unknown as LinearUnconfirmedBuilder
    const writeId = '11111111-1111-4111-8111-111111111111'
    const target = {
      workspaceId: 'workspace-1',
      issue: { id: 'issue-1', identifier: 'ENG-123', url: 'https://example.invalid/ENG-123' }
    }

    await expect(
      runner.runLinearAgentWrite(
        async () => {
          throw new LinearWriteFailure(
            'unconfirmed',
            'Linear write could not be confirmed.',
            new Error('fetch failed: socket hang up Authorization: Bearer linear-secret-token')
          )
        },
        (cause) =>
          builder.linearCreateStyleUnconfirmed('comment', writeId, target, {
            bodyRequired: true,
            cause
          })
      )
    ).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: {
        cause: 'fetch failed: socket hang up Authorization: Bearer [REDACTED]',
        nextSteps: [expect.stringContaining(`--write-id=${writeId}`)]
      }
    })
  })

  it('sanitizes Linear provider messages before they enter RPC error envelopes', () => {
    const message = sanitizeLinearErrorMessage(
      'Linear rejected mutation variables: {"body":"user comment payload","id":"issue-1"} headers: {Authorization: Bearer token-123}\n    at handler (linear.ts:1:1)'
    )

    expect(message).toContain('Linear rejected mutation')
    expect(message).toContain('variables: [REDACTED]')
    expect(message).toContain('headers: [REDACTED]')
    expect(message).not.toContain('user comment payload')
    expect(message).not.toContain('token-123')
    expect(message).not.toContain('at handler')
  })

  it('returns unconfirmed at the write deadline even when the request ignores abort', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn((_signal: AbortSignal) => new Promise<string>(() => undefined))
      const unconfirmed = vi.fn(() =>
        Object.assign(new Error('unconfirmed'), { code: 'linear_write_unconfirmed' })
      )

      const pending = (runtime as unknown as LinearWriteRunner).runLinearAgentWrite(
        write,
        unconfirmed
      )
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'linear_write_unconfirmed'
      })
      await vi.advanceTimersByTimeAsync(25_000)

      await rejection
      expect(unconfirmed).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0]?.[0].aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps payload and destination details in pinned retries', () => {
    const runtime = new OrcaRuntimeService()
    const builder = runtime as unknown as LinearUnconfirmedBuilder
    const writeId = '11111111-1111-4111-8111-111111111111'
    const target = {
      workspaceId: 'workspace-1',
      issue: { id: 'issue-1', identifier: 'ENG-123', url: 'https://example.invalid/ENG-123' }
    }
    const parent = {
      workspaceId: 'workspace-1',
      issue: { id: 'issue-1', identifier: 'ENG-123', url: 'https://example.invalid/ENG-123' }
    }

    const comment = builder.linearCreateStyleUnconfirmed('comment', writeId, target, {
      parentId: 'comment-root',
      bodyRequired: true
    })
    const attach = builder.linearCreateStyleUnconfirmed('attach', writeId, target, {
      title: 'Review link',
      url: 'https://example.invalid/review/1'
    })
    const create = builder.linearCreateStyleUnconfirmed('create', writeId, null, {
      parent,
      team: { id: 'team-2', key: 'OTHER', name: 'Other', workspaceId: 'workspace-1' },
      title: 'Follow up',
      bodyRequired: true,
      createFields: {
        priority: 2,
        estimate: 3,
        dueDate: '2026-06-30',
        projectId: 'project-1',
        labelIds: ['label-1']
      }
    })

    expect(comment.data?.nextSteps?.[0]).toContain('--body-file -')
    expect(comment.data?.nextSteps?.[0]).toContain('--reply-to=comment-root')
    expect(attach.data?.nextSteps?.[0]).toContain('--url URL_HERE')
    expect(attach.data?.nextSteps?.[0]).toContain('--title TITLE_HERE')
    expect(attach.data?.nextSteps?.[0]).toContain('Replace TITLE_HERE/URL_HERE')
    expect(create.data?.nextSteps?.[0]).toContain('--title TITLE_HERE')
    expect(create.data?.nextSteps?.[0]).toContain('--body-file -')
    expect(create.data?.nextSteps?.[0]).toContain('--parent=ENG-123')
    expect(create.data?.nextSteps?.[0]).toContain('--team=OTHER')
    expect(create.data?.nextSteps?.[0]).toContain('--priority=high')
    expect(create.data?.nextSteps?.[0]).toContain('--estimate=3')
    expect(create.data?.nextSteps?.[0]).toContain('--due-date=2026-06-30')
    expect(create.data?.nextSteps?.[0]).toContain('--project=project-1')
    expect(create.data?.nextSteps?.[0]).toContain('--label=label-1')
    expect(create.data?.nextSteps?.[0]).toContain('Replace TITLE_HERE')
  })

  it('requires created issue readback to match enriched field intent', () => {
    const runtime = new OrcaRuntimeService()
    const builder = runtime as unknown as LinearUnconfirmedBuilder
    const issue = {
      id: 'issue-2',
      identifier: 'ENG-2',
      title: 'Follow up',
      url: 'https://example.invalid/ENG-2',
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
      state: { id: 'state-review', name: 'In Review' },
      parent: null,
      project: { id: 'project-1', name: 'Launch' },
      assignee: { id: 'user-1', displayName: 'Ada' },
      priority: 2,
      estimate: 3,
      dueDate: '2026-06-30',
      labels: [{ id: 'label-1', name: 'Bug' }],
      labelIds: ['label-1']
    }

    expect(
      builder.linearCreatedIssueMatchesIntent(issue, {
        stateId: 'state-review',
        assigneeId: 'user-1',
        priority: 2,
        estimate: 3,
        dueDate: '2026-06-30',
        projectId: 'project-1',
        labelIds: ['label-1']
      })
    ).toBe(true)
    expect(
      builder.linearCreatedIssueMatchesIntent(issue, {
        stateId: 'state-review',
        projectId: 'project-2'
      })
    ).toBe(false)
  })

  it('resolves workflow states by UUID or case-insensitive exact name', () => {
    const runtime = new OrcaRuntimeService()
    const states = [
      { id: 'state-review', name: 'In Review', type: 'started' },
      { id: 'state-done', name: 'Done', type: 'completed' }
    ]
    const builder = runtime as unknown as LinearUnconfirmedBuilder

    expect(builder.resolveLinearAgentState('In Review', states)).toBe(states[0])
    expect(builder.resolveLinearAgentState('in review', states)).toBe(states[0])
    expect(builder.resolveLinearAgentState('STATE-REVIEW', states)).toBe(states[0])
    expect(builder.resolveLinearAgentState('Review', states)).toBeNull()
  })

  it('deduplicates write-id lookups by relationship target without comparing payloads', async () => {
    const runtime = new OrcaRuntimeService()
    const tester = runtime as unknown as LinearRetryLookupTester

    tester.readLinearWriteLookup = vi.fn(async () => ({
      id: 'comment-1',
      body: 'different retry body',
      issue: { id: 'issue-1', identifier: 'ENG-1', url: 'https://example.invalid/ENG-1' },
      parentId: 'comment-root',
      threadRootId: 'comment-root',
      url: null
    }))
    await expect(
      tester.getMatchingLinearCommentWrite(
        '11111111-1111-4111-8111-111111111111',
        'issue-1',
        'comment-root',
        'workspace-1',
        true
      )
    ).resolves.toMatchObject({ id: 'comment-1' })

    tester.readLinearWriteLookup = vi.fn(async () => ({
      id: 'attachment-1',
      title: 'Different title',
      url: 'https://example.invalid/different',
      issue: { id: 'issue-1', identifier: 'ENG-1', url: 'https://example.invalid/ENG-1' }
    }))
    await expect(
      tester.getMatchingLinearAttachmentWrite(
        '22222222-2222-4222-8222-222222222222',
        'issue-1',
        'workspace-1',
        true
      )
    ).resolves.toMatchObject({ id: 'attachment-1' })

    tester.readLinearWriteLookup = vi.fn(async () => ({
      id: 'issue-2',
      identifier: 'ENG-2',
      title: 'Different title',
      description: 'Different body',
      url: 'https://example.invalid/ENG-2',
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
      state: null,
      parent: { id: 'issue-1', identifier: 'ENG-1' },
      project: { id: 'project-1', name: 'Launch' }
    }))
    await expect(
      tester.getMatchingLinearCreatedIssue(
        '33333333-3333-4333-8333-333333333333',
        'team-1',
        'issue-1',
        'workspace-1',
        true
      )
    ).resolves.toMatchObject({ id: 'issue-2' })

    await expect(
      tester.getMatchingLinearCreatedIssue(
        '33333333-3333-4333-8333-333333333333',
        'team-1',
        'issue-1',
        'workspace-1',
        true,
        { projectId: 'project-2' }
      )
    ).rejects.toMatchObject({ code: 'linear_invalid_write_id' })
  })

  it('keeps the unconfirmed retry envelope when duplicate recovery lookup fails', async () => {
    const runtime = new OrcaRuntimeService()
    const tester = runtime as unknown as LinearRetryLookupTester
    const unconfirmed = Object.assign(new Error('try pinned retry again'), {
      code: 'linear_write_unconfirmed',
      data: { writeId: '11111111-1111-4111-8111-111111111111' }
    })

    tester.readLinearWriteLookup = vi.fn(async () => {
      throw Object.assign(new Error('socket reset during lookup'), {
        code: 'linear_network_error'
      })
    })

    await expect(
      tester.refetchLinearCommentAfterDuplicate(
        '11111111-1111-4111-8111-111111111111',
        'issue-1',
        null,
        'workspace-1',
        () => unconfirmed
      )
    ).rejects.toBe(unconfirmed)
  })

  it('emits linked issue refresh events for matching workspace links', async () => {
    const runtime = new OrcaRuntimeService()
    const builder = runtime as unknown as LinearUnconfirmedBuilder
    const events: unknown[] = []
    runtime.onClientEvent((event) => events.push(event))
    builder.listResolvedWorktrees = vi.fn(async () => [
      {
        id: 'worktree-1',
        linkedLinearIssue: 'eng-123',
        linkedLinearIssueWorkspaceId: 'workspace-1'
      },
      {
        id: 'worktree-2',
        linkedLinearIssue: 'ENG-123',
        linkedLinearIssueWorkspaceId: 'workspace-2'
      }
    ])

    await builder.notifyLinearLinkedIssueUpdated('workspace-1', 'ENG-123')

    expect(events).toEqual([
      {
        type: 'linearLinkedIssueUpdated',
        worktreeId: 'worktree-1',
        identifier: 'ENG-123',
        workspaceId: 'workspace-1'
      }
    ])
  })
})
