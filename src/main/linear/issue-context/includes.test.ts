import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssueContextResult } from '../../../shared/linear/agent-result-types'
import type { LinearIssueRequest } from '../../../shared/linear/agent-access'
import type { ResolvedIssue } from './client'

// Separate signed/plain client spies expose body reads that would leave uploads.linear.app media unauthorized.
const rawRequest = vi.fn()
const plainRawRequest = vi.fn()

vi.mock('./client', () => ({
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

vi.mock('../client', () => ({
  getPublicFileUrlClient: () => ({ client: { rawRequest } })
}))

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
    const { readOptionalIncludes } = await import('./includes')
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

  it('does not treat an activity page without pageInfo as a complete history', async () => {
    plainRawRequest
      .mockResolvedValueOnce({
        data: {
          issue: {
            history: {
              nodes: [{ id: 'life-1' }, { id: 'life-2' }],
              pageInfo: { hasNextPage: true, endCursor: 'next' }
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: { issue: { history: { nodes: [] } } }
      })
    const { readOptionalIncludes } = await import('./includes')
    const output = result()

    await readOptionalIncludes(
      resolvedIssue(),
      requestWithActivity(),
      output,
      output.meta.includeErrors,
      output.meta.sections
    )

    expect(output.activity).toBeUndefined()
    expect(output.meta.sections.activity).toBeUndefined()
    expect(output.meta.includeErrors).toEqual([
      expect.objectContaining({
        include: 'activity',
        code: 'linear_include_failed'
      })
    ])
    expect(plainRawRequest).toHaveBeenCalledTimes(2)
  })
})
