import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssueContextResult, LinearIssueRequest } from '../../shared/linear-agent-access'
import type { ResolvedIssue } from './issue-context-client'
import { ACTIVITY_QUERY } from './issue-activity-raw'
import {
  ATTACHMENTS_QUERY,
  CHILDREN_QUERY,
  COMMENTS_QUERY,
  INVERSE_RELATIONS_QUERY,
  RELATIONS_QUERY
} from './issue-context-raw'

// The signed public-file-url client is what body reads must use so Linear
// rewrites inline uploads.linear.app URLs into temporary signed URLs. The plain
// entry client is a distinct spy so a regression back to it fails these tests.
const rawRequest = vi.fn()
const plainRawRequest = vi.fn()

vi.mock('./issue-context-client', () => ({
  getRequiredEntry: () => ({
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Brennan',
      email: 'brennan@example.com'
    },
    client: { client: { rawRequest: plainRawRequest } }
  }),
  withLinearRead: async (_entry: unknown, read: () => Promise<unknown>) => read()
}))

vi.mock('./client', () => ({
  getPublicFileUrlClient: () => ({ client: { rawRequest } })
}))

function rawChild(index: number) {
  return {
    id: `child-${index}`,
    identifier: `ENG-${index}`,
    title: `Child ${index}`,
    url: `https://linear.app/acme/issue/ENG-${index}`,
    labels: { nodes: [] }
  }
}

function rawComment(index: number) {
  return {
    id: `comment-${index}`,
    body: `Comment ${index}`
  }
}

function resolvedIssue(): ResolvedIssue {
  return {
    issue: {
      id: 'parent',
      identifier: 'ENG-1',
      title: 'Parent',
      url: 'https://linear.app/acme/issue/ENG-1',
      labels: []
    },
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Brennan',
      email: 'brennan@example.com'
    }
  }
}

function request(): LinearIssueRequest {
  return {
    include: {
      comments: false,
      children: true,
      attachments: false,
      relations: false,
      activity: false
    },
    depth: 2
  }
}

function requestWithDepth(depth: number): LinearIssueRequest {
  return {
    ...request(),
    depth
  }
}

function requestWithComments(): LinearIssueRequest {
  return {
    include: {
      comments: true,
      children: false,
      attachments: false,
      relations: false,
      activity: false
    },
    depth: 2
  }
}

function requestWithActivity(): LinearIssueRequest {
  return {
    include: {
      comments: false,
      children: false,
      attachments: false,
      relations: false,
      activity: true
    },
    depth: 2
  }
}

function result(): LinearIssueContextResult {
  return {
    issue: resolvedIssue().issue,
    meta: {
      requested: {
        current: false,
        include: {
          comments: false,
          children: true,
          attachments: false,
          relations: false,
          activity: false
        },
        depth: 2
      },
      resolved: {
        id: 'parent',
        identifier: 'ENG-1',
        workspaceId: 'workspace-1',
        workspaceName: 'Acme'
      },
      partial: false,
      includeErrors: [],
      sections: {}
    }
  }
}

describe('Linear issue context includes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('declares cursor variables on every paged include query', () => {
    for (const query of [
      COMMENTS_QUERY,
      CHILDREN_QUERY,
      ATTACHMENTS_QUERY,
      RELATIONS_QUERY,
      ACTIVITY_QUERY,
      INVERSE_RELATIONS_QUERY
    ]) {
      expect(query).toContain('$after: String')
      expect(query).toContain('after: $after')
    }
    expect(ACTIVITY_QUERY).not.toContain('attachment { id title url source }')
  })

  it('does not probe grandchildren when the first child page exhausts the node cap', async () => {
    for (let page = 0; page < 4; page += 1) {
      rawRequest.mockResolvedValueOnce({
        data: {
          issue: {
            children: {
              nodes: Array.from({ length: 50 }, (_, index) => rawChild(page * 50 + index + 1)),
              pageInfo: {
                hasNextPage: page < 3,
                endCursor: page < 3 ? `cursor-${page}` : null
              }
            }
          }
        }
      })
    }
    const { readOptionalIncludes } = await import('./issue-context-includes')
    const output = result()

    await readOptionalIncludes(resolvedIssue(), request(), output, [], output.meta.sections)

    expect(output.children).toHaveLength(200)
    expect(output.meta.sections.children).toMatchObject({
      returned: 200,
      cap: 200,
      capReached: true,
      mayHaveMore: true
    })
    expect(rawRequest).toHaveBeenCalledTimes(4)
    expect(rawRequest.mock.calls[0]?.[1]).toEqual({ id: 'parent', first: 50 })
    expect(rawRequest.mock.calls[1]?.[1]).toEqual({
      id: 'parent',
      first: 50,
      after: 'cursor-0'
    })
  })

  it('paginates comments up to the advertised include cap', async () => {
    for (let page = 0; page < 3; page += 1) {
      rawRequest.mockResolvedValueOnce({
        data: {
          issue: {
            comments: {
              nodes: Array.from({ length: 50 }, (_, index) => rawComment(page * 50 + index + 1)),
              pageInfo: {
                hasNextPage: page < 2,
                endCursor: page < 2 ? `comment-cursor-${page}` : null
              }
            }
          }
        }
      })
    }
    const { readOptionalIncludes } = await import('./issue-context-includes')
    const output = result()

    await readOptionalIncludes(
      resolvedIssue(),
      requestWithComments(),
      output,
      [],
      output.meta.sections
    )

    expect(output.comments).toHaveLength(150)
    expect(output.meta.sections.comments).toMatchObject({
      returned: 150,
      cap: 500,
      capReached: false
    })
    expect(rawRequest).toHaveBeenCalledTimes(3)
    expect(rawRequest.mock.calls[2]?.[1]).toEqual({
      id: 'parent',
      first: 50,
      after: 'comment-cursor-1'
    })
  })

  it('returns normalized issue activity with user, bot, and field changes', async () => {
    plainRawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          history: {
            nodes: [
              {
                id: 'history-1',
                createdAt: '2026-07-20T10:00:00.000Z',
                actor: { id: 'user-1', displayName: 'Ada' },
                fromState: { id: 'todo', name: 'Todo' },
                toState: { id: 'started', name: 'In Progress' },
                addedLabels: [{ id: 'bug', name: 'Bug' }]
              },
              {
                id: 'history-2',
                botActor: { id: 'bot-1', name: 'Workflow', type: 'app' },
                fromPriority: 3,
                toPriority: 2,
                relationChanges: [{ identifier: 'ENG-9', type: 'blocks' }]
              },
              {
                id: 'history-3',
                archived: false,
                trashed: false
              }
            ],
            pageInfo: { hasNextPage: false }
          }
        }
      }
    })
    const { readOptionalIncludes } = await import('./issue-context-includes')
    const output = result()

    await readOptionalIncludes(
      resolvedIssue(),
      requestWithActivity(),
      output,
      [],
      output.meta.sections
    )

    expect(output.activity).toEqual([
      expect.objectContaining({
        id: 'history-1',
        actor: expect.objectContaining({ kind: 'user', displayName: 'Ada' }),
        changes: [
          {
            field: 'state',
            from: { id: 'todo', name: 'Todo' },
            to: { id: 'started', name: 'In Progress' }
          },
          { field: 'labelsAdded', to: [{ id: 'bug', name: 'Bug' }] }
        ]
      }),
      expect.objectContaining({
        id: 'history-2',
        actor: expect.objectContaining({ kind: 'bot', name: 'Workflow' }),
        changes: [
          { field: 'priority', from: 3, to: 2 },
          { field: 'relations', to: [{ identifier: 'ENG-9', type: 'blocks' }] }
        ]
      }),
      expect.objectContaining({
        id: 'history-3',
        actor: { kind: 'system', displayName: 'Linear' },
        changes: [
          { field: 'archived', to: false },
          { field: 'trashed', to: false }
        ]
      })
    ])
    expect(output.meta.sections.activity).toMatchObject({
      returned: 3,
      cap: 250,
      capReached: false
    })
  })

  it('caps activity history at five provider pages', async () => {
    for (let page = 0; page < 5; page += 1) {
      plainRawRequest.mockResolvedValueOnce({
        data: {
          issue: {
            history: {
              nodes: Array.from({ length: 50 }, (_, index) => ({
                id: `history-${page * 50 + index}`
              })),
              pageInfo: { hasNextPage: true, endCursor: `activity-cursor-${page}` }
            }
          }
        }
      })
    }
    const { readOptionalIncludes } = await import('./issue-context-includes')
    const output = result()

    await readOptionalIncludes(
      resolvedIssue(),
      requestWithActivity(),
      output,
      [],
      output.meta.sections
    )

    expect(output.activity).toHaveLength(250)
    expect(output.meta.sections.activity).toMatchObject({
      returned: 250,
      cap: 250,
      capReached: true,
      hasMore: true
    })
    expect(plainRawRequest).toHaveBeenCalledTimes(5)
    expect(plainRawRequest.mock.calls[4]?.[1]).toEqual({
      id: 'parent',
      first: 50,
      after: 'activity-cursor-3'
    })
  })

  it('extracts comment media past the body truncation cap', async () => {
    const url = 'https://uploads.linear.app/w/file/late?sig=1'
    const body = `${'x'.repeat(20_001)}\n![late](${url})`
    rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          comments: {
            nodes: [{ id: 'comment-1', body }],
            pageInfo: { hasNextPage: false }
          }
        }
      }
    })
    const { readOptionalIncludes } = await import('./issue-context-includes')
    const output = result()

    await readOptionalIncludes(
      resolvedIssue(),
      requestWithComments(),
      output,
      [],
      output.meta.sections
    )

    expect(output.comments?.[0]?.bodyTruncated).toBe(true)
    expect(output.comments?.[0]?.body).not.toContain(url)
    expect(output.comments?.[0]?.inlineMedia).toEqual([
      {
        source: 'comment',
        sourceId: 'comment-1',
        url,
        altText: 'late',
        fileName: 'late',
        linearUpload: true
      }
    ])
  })

  it('reads comment and child bodies through the signed public-file-url client', async () => {
    // Guards STA-1246: reverting to the plain entry client would return unsigned
    // uploads.linear.app URLs that 401 for agents.
    rawRequest.mockResolvedValue({
      data: {
        issue: {
          comments: { nodes: [rawComment(1)], pageInfo: { hasNextPage: false } }
        }
      }
    })
    const { readOptionalIncludes } = await import('./issue-context-includes')
    const output = result()

    await readOptionalIncludes(
      resolvedIssue(),
      requestWithComments(),
      output,
      [],
      output.meta.sections
    )

    expect(rawRequest).toHaveBeenCalled()
    expect(plainRawRequest).not.toHaveBeenCalled()
  })

  it('marks section metadata when children are truncated by requested depth', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          children: {
            nodes: [rawChild(1)],
            pageInfo: { hasNextPage: false }
          }
        }
      }
    })
    const { readOptionalIncludes } = await import('./issue-context-includes')
    const output = result()

    await readOptionalIncludes(
      resolvedIssue(),
      requestWithDepth(1),
      output,
      [],
      output.meta.sections
    )

    expect(output.children).toHaveLength(1)
    expect(output.children?.[0]?.mayHaveMore).toBe(true)
    expect(output.meta.sections.children).toMatchObject({
      returned: 1,
      capReached: false,
      mayHaveMore: true
    })
    expect(rawRequest).toHaveBeenCalledTimes(1)
  })
})
