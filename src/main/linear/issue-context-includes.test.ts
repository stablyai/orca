import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssueContextResult, LinearIssueRequest } from '../../shared/linear-agent-access'
import type { ResolvedIssue } from './issue-context-client'
import {
  ATTACHMENTS_QUERY,
  CHILDREN_QUERY,
  COMMENTS_QUERY,
  RELATIONS_QUERY
} from './issue-context-raw'

const rawRequest = vi.fn()

vi.mock('./issue-context-client', () => ({
  getRequiredEntry: () => ({
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Brennan',
      email: 'brennan@example.com'
    },
    client: { client: { rawRequest } }
  }),
  withLinearRead: async (_entry: unknown, read: () => Promise<unknown>) => read()
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
    include: { comments: false, children: true, attachments: false, relations: false },
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
    include: { comments: true, children: false, attachments: false, relations: false },
    depth: 2
  }
}

function result(): LinearIssueContextResult {
  return {
    issue: resolvedIssue().issue,
    meta: {
      requested: {
        current: false,
        include: { comments: false, children: true, attachments: false, relations: false },
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
    for (const query of [COMMENTS_QUERY, CHILDREN_QUERY, ATTACHMENTS_QUERY, RELATIONS_QUERY]) {
      expect(query).toContain('$after: String')
      expect(query).toContain('after: $after')
    }
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
