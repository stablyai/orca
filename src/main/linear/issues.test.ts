import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import { credentialDecryptionMessage } from '../../shared/integration-credential-errors'

const rawRequest = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args),
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

function makeEntry(options?: {
  workspaceId?: string
  organizationName?: string
  request?: typeof rawRequest
}): LinearClientForWorkspace {
  return {
    workspace: {
      id: options?.workspaceId ?? 'workspace-1',
      organizationId: options?.workspaceId ?? 'workspace-1',
      organizationName: options?.organizationName ?? 'Workspace',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      client: { rawRequest: options?.request ?? rawRequest }
    }
  } as unknown as LinearClientForWorkspace
}

function rawIssue(id: string, updatedAt = '2026-01-01T00:00:00.000Z') {
  return {
    id,
    identifier: id,
    title: id,
    description: 'Description',
    url: `https://linear.app/${id}`,
    estimate: 3,
    priority: 2,
    updatedAt,
    labelIds: ['label-1'],
    state: { name: 'Todo', type: 'unstarted', color: '#888888' },
    team: { id: 'team-1', name: 'Team', key: 'TM' },
    assignee: { id: 'user-1', displayName: 'Ada', avatarUrl: null },
    labels: { nodes: [{ id: 'label-1', name: 'Bug' }] }
  }
}

function issueConnectionResponse(
  ids: string[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false }
) {
  return {
    data: {
      issues: {
        nodes: ids.map((id) => rawIssue(id)),
        pageInfo
      }
    }
  }
}

function issueConnectionResponseFromIssues(
  issues: ReturnType<typeof rawIssue>[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false }
) {
  return {
    data: {
      issues: {
        nodes: issues,
        pageInfo
      }
    }
  }
}

function datedIssues(prefix: string, count: number, startMs: number, startIndex = 1) {
  return Array.from({ length: count }, (_, index) =>
    rawIssue(`${prefix}-${startIndex + index}`, new Date(startMs - index * 1000).toISOString())
  )
}

describe('Linear issue queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthError.mockReturnValue(false)
    getClients.mockReturnValue([makeEntry()])
  })

  it('lists issues with one raw GraphQL request and maps row fields', async () => {
    rawRequest.mockResolvedValueOnce({
      data: { issues: { nodes: [rawIssue('LIN-1')] } }
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 36, 'workspace-1')).resolves.toMatchObject({
      items: [
        {
          id: 'LIN-1',
          labels: ['Bug'],
          labelIds: ['label-1'],
          workspaceId: 'workspace-1',
          team: { id: 'team-1' },
          estimate: 3,
          dueDate: null
        }
      ],
      hasMore: false
    })

    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(rawRequest.mock.calls[0][0]).toContain('query OrcaLinearIssues')
    expect(rawRequest.mock.calls[0][0]).toContain('pageInfo')
    expect(rawRequest.mock.calls[0][0]).toContain('estimate')
  })

  it('fetches issue comments with one request (no per-comment user N+1)', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          comments: {
            nodes: [
              {
                id: 'comment-1',
                body: 'First',
                createdAt: '2026-01-02T03:04:05.000Z',
                user: { displayName: 'Ada', avatarUrl: 'https://example.com/a.png' }
              },
              {
                id: 'comment-2',
                body: 'Second',
                createdAt: '2026-01-02T03:05:05.000Z',
                user: { displayName: 'Grace', avatarUrl: null }
              },
              {
                id: 'comment-3',
                body: 'Third',
                createdAt: '2026-01-02T03:06:05.000Z',
                user: null
              }
            ]
          }
        }
      }
    })
    const { getIssueComments } = await import('./issues')

    await expect(getIssueComments('issue-uuid', 'workspace-1')).resolves.toEqual([
      {
        id: 'comment-1',
        body: 'First',
        createdAt: '2026-01-02T03:04:05.000Z',
        user: { displayName: 'Ada', avatarUrl: 'https://example.com/a.png' }
      },
      {
        id: 'comment-2',
        body: 'Second',
        createdAt: '2026-01-02T03:05:05.000Z',
        user: { displayName: 'Grace', avatarUrl: undefined }
      },
      { id: 'comment-3', body: 'Third', createdAt: '2026-01-02T03:06:05.000Z', user: undefined }
    ])

    // The point of the fix: one request regardless of comment count.
    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(rawRequest.mock.calls[0][0]).toContain('query OrcaLinearIssueComments')
    expect(rawRequest.mock.calls[0][0]).toContain('user {')
    expect(rawRequest.mock.calls[0][1]).toEqual({ id: 'issue-uuid' })
  })

  it('returns an empty comment list when no Linear client is configured', async () => {
    getClients.mockReturnValue([])
    const { getIssueComments } = await import('./issues')

    await expect(getIssueComments('issue-uuid', 'workspace-1')).resolves.toEqual([])
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('passes team filters into Linear before list pagination', async () => {
    rawRequest.mockResolvedValueOnce({
      data: { issues: { nodes: [rawIssue('LIN-1')], pageInfo: { hasNextPage: false } } }
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('open', 10, 'workspace-1', 'team-1')).resolves.toMatchObject({
      items: [{ id: 'LIN-1' }],
      hasMore: false
    })

    expect(rawRequest.mock.calls[0][1]).toMatchObject({
      first: 10,
      filter: {
        state: { type: { nin: ['completed', 'canceled'] } },
        team: { id: { eq: 'team-1' } }
      }
    })
  })

  it('keeps single-workspace search results in Linear relevance order', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        searchIssues: {
          nodes: [
            rawIssue('LIN-OLD', '2026-01-01T00:00:00.000Z'),
            rawIssue('LIN-NEW', '2026-02-01T00:00:00.000Z')
          ]
        }
      }
    })
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('bug', 36, 'workspace-1')).resolves.toMatchObject([
      { id: 'LIN-OLD' },
      { id: 'LIN-NEW' }
    ])

    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(rawRequest.mock.calls[0][0]).toContain('query OrcaLinearIssueSearch')
    expect(rawRequest.mock.calls[0][0]).toContain('searchIssues(term: $term')
    expect(rawRequest.mock.calls[0][1]).toEqual({ term: 'bug', first: 36 })
  })

  it('uses raw labelIds as the complete mutation-safe label set', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        issues: {
          nodes: [
            {
              ...rawIssue('LIN-1'),
              labelIds: ['label-1', 'label-2'],
              labels: { nodes: [{ id: 'label-1', name: 'Bug' }] }
            }
          ]
        }
      }
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 36, 'workspace-1')).resolves.toMatchObject({
      items: [
        {
          id: 'LIN-1',
          labels: ['Bug'],
          labelIds: ['label-1', 'label-2']
        }
      ]
    })
  })

  it('surfaces Linear credential decrypt errors on active issue reads and mutations', async () => {
    const error = new Error(credentialDecryptionMessage('Linear'))
    getClients.mockImplementation(() => {
      throw error
    })
    const { createIssue, listIssues, searchIssues } = await import('./issues')

    await expect(searchIssues('bug', 20, 'workspace-1')).rejects.toThrow(error.message)
    await expect(listIssues('all', 20, 'workspace-1')).rejects.toThrow(error.message)
    await expect(createIssue('team-1', 'Fix auth', undefined, 'workspace-1')).rejects.toThrow(
      error.message
    )
  })

  it('marks plain list results as having more when Linear has a next page', async () => {
    rawRequest.mockResolvedValueOnce({
      data: { issues: { nodes: [rawIssue('LIN-1')], pageInfo: { hasNextPage: true } } }
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 36, 'workspace-1')).resolves.toMatchObject({
      items: [{ id: 'LIN-1' }],
      hasMore: true
    })
  })

  it('loads plain issue lists past Linear connection page size with cursors', async () => {
    rawRequest
      .mockResolvedValueOnce(
        issueConnectionResponse(
          Array.from({ length: 50 }, (_, index) => `LIN-${index + 1}`),
          { hasNextPage: true, endCursor: 'cursor-50' }
        )
      )
      .mockResolvedValueOnce(
        issueConnectionResponse(
          Array.from({ length: 22 }, (_, index) => `LIN-${index + 51}`),
          { hasNextPage: false, endCursor: null }
        )
      )
    const { listIssues } = await import('./issues')

    const result = await listIssues('all', 72, 'workspace-1')

    expect(result.items).toHaveLength(72)
    expect(result.hasMore).toBe(false)
    expect(rawRequest).toHaveBeenCalledTimes(2)
    expect(rawRequest.mock.calls[0][1]).toMatchObject({ first: 50, orderBy: 'updatedAt' })
    expect(rawRequest.mock.calls[0][1]).not.toHaveProperty('after')
    expect(rawRequest.mock.calls[1][1]).toMatchObject({
      first: 22,
      after: 'cursor-50',
      orderBy: 'updatedAt'
    })
  })

  it('marks multi-workspace plain lists as having more when the merged result is clipped', async () => {
    getClients.mockReturnValue([
      makeEntry(),
      makeEntry({ workspaceId: 'workspace-2', organizationName: 'Second Workspace' })
    ])
    rawRequest
      .mockResolvedValueOnce({
        data: {
          issues: {
            nodes: [rawIssue('LIN-OLD', '2026-01-01T00:00:00.000Z')],
            pageInfo: { hasNextPage: false }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          issues: {
            nodes: [rawIssue('LIN-NEW', '2026-02-01T00:00:00.000Z')],
            pageInfo: { hasNextPage: false }
          }
        }
      })
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 1, 'all')).resolves.toMatchObject({
      items: [{ id: 'LIN-NEW' }],
      hasMore: true
    })
  })

  it('keeps partial workspace errors on multi-workspace lists', async () => {
    const secondWorkspaceRequest = vi.fn().mockRejectedValue(new Error('fetch failed'))
    getClients.mockReturnValue([
      makeEntry(),
      makeEntry({
        workspaceId: 'workspace-2',
        organizationName: 'Second Workspace',
        request: secondWorkspaceRequest
      })
    ])
    rawRequest.mockResolvedValueOnce({
      data: {
        issues: {
          nodes: [rawIssue('LIN-OK')],
          pageInfo: { hasNextPage: false }
        }
      }
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 10, 'all')).resolves.toMatchObject({
      items: [{ id: 'LIN-OK' }],
      errors: [
        {
          workspaceId: 'workspace-2',
          workspaceName: 'Second Workspace',
          type: 'network',
          message: 'fetch failed'
        }
      ]
    })
  })

  it('keeps workspace errors on single-workspace lists', async () => {
    rawRequest.mockRejectedValueOnce(new Error('fetch failed'))
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 10, 'workspace-1')).resolves.toMatchObject({
      items: [],
      hasMore: false,
      errors: [
        {
          workspaceId: 'workspace-1',
          workspaceName: 'Workspace',
          type: 'network',
          message: 'fetch failed'
        }
      ]
    })
  })

  it('pages only workspaces that can affect the global multi-workspace cutoff', async () => {
    const firstWorkspaceRequest = vi.fn()
    const secondWorkspaceRequest = vi.fn()
    getClients.mockReturnValue([
      makeEntry({ request: firstWorkspaceRequest }),
      makeEntry({
        workspaceId: 'workspace-2',
        organizationName: 'Second Workspace',
        request: secondWorkspaceRequest
      })
    ])
    firstWorkspaceRequest
      .mockResolvedValueOnce(
        issueConnectionResponseFromIssues(datedIssues('W1', 50, Date.UTC(2026, 3, 1)), {
          hasNextPage: true,
          endCursor: 'workspace-1-cursor-50'
        })
      )
      .mockResolvedValueOnce(
        issueConnectionResponseFromIssues(
          datedIssues('W1', 22, Date.UTC(2026, 3, 1) - 50_000, 51),
          { hasNextPage: true, endCursor: 'workspace-1-cursor-72' }
        )
      )
    secondWorkspaceRequest.mockResolvedValueOnce(
      issueConnectionResponseFromIssues(datedIssues('W2', 50, Date.UTC(2026, 0, 1)), {
        hasNextPage: true,
        endCursor: 'workspace-2-cursor-50'
      })
    )
    const { listIssues } = await import('./issues')

    const result = await listIssues('all', 72, 'all')

    expect(result.items).toHaveLength(72)
    expect(result.items.map((issue) => issue.id)).toEqual(
      Array.from({ length: 72 }, (_, index) => `W1-${index + 1}`)
    )
    expect(result.hasMore).toBe(true)
    expect(firstWorkspaceRequest).toHaveBeenCalledTimes(2)
    expect(firstWorkspaceRequest.mock.calls[0][1]).toMatchObject({
      first: 50,
      orderBy: 'updatedAt'
    })
    expect(firstWorkspaceRequest.mock.calls[0][1]).not.toHaveProperty('after')
    expect(firstWorkspaceRequest.mock.calls[1][1]).toMatchObject({
      first: 22,
      after: 'workspace-1-cursor-50',
      orderBy: 'updatedAt'
    })
    expect(secondWorkspaceRequest).toHaveBeenCalledTimes(1)
    expect(secondWorkspaceRequest.mock.calls[0][1]).toMatchObject({
      first: 50,
      orderBy: 'updatedAt'
    })
    expect(secondWorkspaceRequest.mock.calls[0][1]).not.toHaveProperty('after')
  })

  it('sends estimate updates through to Linear', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: {
          updateIssue
        }
      }
    ])
    const { updateIssue: updateLinearIssue } = await import('./issues')

    await expect(updateLinearIssue('issue-1', { estimate: 5 }, 'workspace-1')).resolves.toEqual({
      ok: true
    })

    expect(updateIssue).toHaveBeenCalledWith('issue-1', { estimate: 5 })
  })

  it('sends due date updates through to Linear', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true })
    getClients.mockReturnValue([{ ...makeEntry(), client: { updateIssue } }])
    const { updateIssue: updateLinearIssue } = await import('./issues')

    await expect(
      updateLinearIssue('issue-1', { dueDate: '2026-06-30' }, 'workspace-1')
    ).resolves.toEqual({ ok: true })

    expect(updateIssue).toHaveBeenCalledWith('issue-1', { dueDate: '2026-06-30' })
  })

  it('reads back agent state updates before confirming success', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true })
    rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'Fix thing',
          description: 'Description',
          url: 'https://linear.app/ENG-1',
          team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
          state: { id: 'state-review', name: 'In Review' },
          parent: null
        }
      }
    })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: { updateIssue, client: { rawRequest } }
      }
    ])
    const { updateIssueForAgent } = await import('./issues')

    await expect(
      updateIssueForAgent('issue-1', { stateId: 'state-review' }, 'workspace-1')
    ).resolves.toMatchObject({ state: { id: 'state-review' } })

    expect(updateIssue).toHaveBeenCalledWith('issue-1', { stateId: 'state-review' })
    expect(rawRequest.mock.calls[0][0]).toContain('query OrcaLinearIssueByUuid')
  })

  it('reads back agent task field updates before confirming success', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true })
    rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'Fix thing',
          description: 'Description',
          url: 'https://linear.app/ENG-1',
          team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
          state: { id: 'state-review', name: 'In Review' },
          parent: null,
          priority: 1,
          estimate: 5,
          dueDate: '2026-06-30',
          labelIds: ['label-1'],
          labels: { nodes: [{ id: 'label-1', name: 'Bug' }] }
        }
      }
    })
    getClients.mockReturnValue([
      { ...makeEntry(), client: { updateIssue, client: { rawRequest } } }
    ])
    const { updateIssueForAgent } = await import('./issues')

    await expect(
      updateIssueForAgent(
        'issue-1',
        { priority: 1, estimate: 5, dueDate: '2026-06-30', labelIds: ['label-1'] },
        'workspace-1'
      )
    ).resolves.toMatchObject({ priority: 1, dueDate: '2026-06-30', labelIds: ['label-1'] })

    expect(updateIssue).toHaveBeenCalledWith('issue-1', {
      priority: 1,
      estimate: 5,
      dueDate: '2026-06-30',
      labelIds: ['label-1']
    })
  })

  it('treats post-state-update readback misses as unconfirmed', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true })
    rawRequest.mockResolvedValueOnce({ data: { issue: null } })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: { updateIssue, client: { rawRequest } }
      }
    ])
    const { updateIssueForAgent } = await import('./issues')

    await expect(
      updateIssueForAgent('issue-1', { stateId: 'state-review' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('treats direct write-id lookup misses as null', async () => {
    rawRequest
      .mockRejectedValueOnce(
        new Error('Entity not found: Issue - Could not find referenced Issue.')
      )
      .mockRejectedValueOnce(
        new Error('Entity not found: Comment - Could not find referenced Comment.')
      )
      .mockRejectedValueOnce(
        new Error('Entity not found: Attachment - Could not find referenced Attachment.')
      )
    getClients.mockReturnValue([{ ...makeEntry(), client: { client: { rawRequest } } }])
    const { getIssueByUuidForAgent, getCommentByUuidForAgent, getAttachmentByUuidForAgent } =
      await import('./issues')

    await expect(getIssueByUuidForAgent('missing-issue', 'workspace-1')).resolves.toBeNull()
    await expect(getCommentByUuidForAgent('missing-comment', 'workspace-1')).resolves.toBeNull()
    await expect(
      getAttachmentByUuidForAgent('missing-attachment', 'workspace-1')
    ).resolves.toBeNull()
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('sends threaded agent comments with a client supplied id', async () => {
    const createComment = vi.fn().mockResolvedValue({
      success: true,
      comment: Promise.resolve({ id: 'comment-1', url: 'https://linear.app/comment-1' })
    })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: { createComment }
      }
    ])
    const { addIssueComment } = await import('./issues')

    await expect(
      addIssueComment('issue-1', 'hello', 'workspace-1', {
        id: '11111111-1111-4111-8111-111111111111',
        parentId: 'parent-comment'
      })
    ).resolves.toMatchObject({ ok: true, id: 'comment-1', parentId: 'parent-comment' })

    expect(createComment).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      issueId: 'issue-1',
      body: 'hello',
      parentId: 'parent-comment'
    })
  })

  it('creates agent attachments with a client supplied id', async () => {
    const createAttachment = vi.fn().mockResolvedValue({
      success: true,
      attachment: Promise.resolve({ id: 'attachment-1' })
    })
    rawRequest.mockResolvedValueOnce({
      data: {
        attachment: {
          id: 'attachment-1',
          title: 'PR link',
          url: 'https://example.com/review/1',
          issue: { id: 'issue-1', identifier: 'ENG-1', url: 'https://linear.app/ENG-1' }
        }
      }
    })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: { createAttachment, client: { rawRequest } }
      }
    ])
    const { createIssueAttachment } = await import('./issues')

    await expect(
      createIssueAttachment(
        'issue-1',
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'PR link',
          url: 'https://example.com/review/1'
        },
        'workspace-1'
      )
    ).resolves.toMatchObject({ id: 'attachment-1', issue: { identifier: 'ENG-1' } })

    expect(createAttachment).toHaveBeenCalledWith({
      id: '22222222-2222-4222-8222-222222222222',
      issueId: 'issue-1',
      title: 'PR link',
      url: 'https://example.com/review/1'
    })
  })

  it('treats post-mutation attachment readback misses as unconfirmed', async () => {
    const createAttachment = vi.fn().mockResolvedValue({
      success: true,
      attachment: Promise.resolve({ id: 'attachment-1' })
    })
    rawRequest.mockResolvedValueOnce({ data: { attachment: null } })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: { createAttachment, client: { rawRequest } }
      }
    ])
    const { createIssueAttachment } = await import('./issues')

    await expect(
      createIssueAttachment(
        'issue-1',
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'PR link',
          url: 'https://example.com/review/1'
        },
        'workspace-1'
      )
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('creates parented agent issues with a client supplied id and project id', async () => {
    const createIssue = vi.fn().mockResolvedValue({
      success: true,
      issue: Promise.resolve({ id: 'issue-created' })
    })
    rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          id: 'issue-created',
          identifier: 'ENG-2',
          title: 'Follow up',
          url: 'https://linear.app/ENG-2',
          team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
          state: { id: 'state-1', name: 'Todo' },
          parent: { id: 'issue-parent', identifier: 'ENG-1' }
        }
      }
    })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: { createIssue, client: { rawRequest } }
      }
    ])
    const { createIssueForAgent } = await import('./issues')

    await expect(
      createIssueForAgent('team-1', 'Follow up', 'Details', 'workspace-1', {
        id: '33333333-3333-4333-8333-333333333333',
        parentId: 'issue-parent',
        projectId: 'project-1'
      })
    ).resolves.toMatchObject({
      id: 'issue-created',
      parent: { id: 'issue-parent' },
      team: { key: 'ENG' }
    })

    expect(createIssue).toHaveBeenCalledWith({
      id: '33333333-3333-4333-8333-333333333333',
      teamId: 'team-1',
      title: 'Follow up',
      description: 'Details',
      parentId: 'issue-parent',
      projectId: 'project-1'
    })
    expect(rawRequest.mock.calls.at(-1)?.[0]).toContain('description')
  })

  it('treats post-create readback misses as unconfirmed', async () => {
    const createIssue = vi.fn().mockResolvedValue({
      success: true,
      issue: Promise.resolve({ id: 'issue-created' })
    })
    rawRequest.mockResolvedValueOnce({ data: { issue: null } })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: { createIssue, client: { rawRequest } }
      }
    ])
    const { createIssueForAgent } = await import('./issues')

    await expect(
      createIssueForAgent('team-1', 'Follow up', 'Details', 'workspace-1', {
        id: '33333333-3333-4333-8333-333333333333'
      })
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('treats post-create readback auth-like errors as unconfirmed', async () => {
    const authError = new Error('Auth expired during confirmation')
    isAuthError.mockImplementation((error) => error === authError)
    const createIssue = vi.fn().mockResolvedValue({
      success: true,
      issue: Promise.resolve({ id: 'issue-created' })
    })
    rawRequest.mockRejectedValueOnce(authError)
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: { createIssue, client: { rawRequest } }
      }
    ])
    const { createIssueForAgent } = await import('./issues')

    await expect(
      createIssueForAgent('team-1', 'Follow up', 'Details', 'workspace-1', {
        id: '33333333-3333-4333-8333-333333333333'
      })
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
    expect(clearToken).not.toHaveBeenCalled()
  })

  it('resolves a reply target to its thread root without reading capped issue comments', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        comment: {
          id: 'reply-1',
          url: 'https://linear.app/comment/reply-1',
          body: 'Nested reply',
          parent: { id: 'root-1' },
          issue: { id: 'issue-1', identifier: 'ENG-1', url: 'https://linear.app/ENG-1' }
        }
      }
    })
    const { getIssueCommentThreadRoot } = await import('./issues')

    await expect(getIssueCommentThreadRoot('issue-1', 'reply-1', 'workspace-1')).resolves.toEqual({
      id: 'root-1',
      parentId: 'root-1'
    })

    expect(rawRequest.mock.calls[0][0]).toContain('query OrcaLinearCommentByUuid')
    expect(rawRequest.mock.calls[0][0]).toContain('body')
  })
})
