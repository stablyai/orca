import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'

vi.mock('./instance-credential-store', () => ({
  readItsaplanInstance: () => ({
    id: 'inst1',
    appUrl: 'https://app.example.com',
    apiUrl: 'https://api.example.com'
  }),
  readItsaplanApiKey: () => 'secret-key-k',
  getItsaplanCredentialError: () => undefined,
  getItsaplanCredentialProtection: () => null,
  itsaplanInstanceIdForApiUrl: () => 'inst1',
  saveItsaplanInstance: async () => {},
  clearItsaplanInstance: async () => {}
}))

import { itsaplanGetIssue, itsaplanListIssues } from './itsaplan-issue-read'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

const board = {
  project: { id: 5, ref: 'team.K', key: 'K', name: 'Kay' },
  columns: [{ id: 1, name: 'Todo', stateType: 'unstarted', position: 1 }],
  labels: [],
  assignees: []
}

const rawIssue = {
  id: 7,
  projectId: 5,
  sequenceNumber: 1,
  identifier: 'K-1',
  columnId: 1,
  assigneeUserId: null,
  delegateUserId: null,
  parentId: null,
  title: 'T',
  description: '',
  priority: null,
  labelIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

function comment(id: number, createdAt: string, replyToId: number | null = null) {
  return {
    id,
    kind: 'comment',
    replyToId,
    body: `b${id}`,
    actorUserId: 'u1',
    actorName: 'Ana',
    createdAt
  }
}

afterEach(() => setMainHttpClient(null))

describe('itsaplanListIssues', () => {
  it('reports a network failure on the me lookup as unreachable, not invalidApiKey', async () => {
    setMainHttpClient({
      fetch: async (url: string) => {
        if (url.endsWith('/me')) {
          throw new TypeError('fetch failed')
        }
        return jsonResponse(board)
      },
      proxySession: () => null
    })

    const error = await itsaplanListIssues({
      projectRef: 'team.K',
      filters: { assignee: 'me' }
    }).catch((caught: unknown) => caught)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caught value is the error thrown by the call under test.
    expect((error as Error).message.startsWith('unreachable:')).toBe(true)
  })
})

describe('itsaplanListIssues state columns', () => {
  it('reads each matching column with its own columnId', async () => {
    const issueUrls: string[] = []
    setMainHttpClient({
      fetch: async (url: string) => {
        if (url.includes('/issues?')) {
          issueUrls.push(url)
          return jsonResponse([])
        }
        return jsonResponse({
          ...board,
          columns: [
            { id: 1, name: 'Todo', stateType: 'unstarted', position: 1 },
            { id: 2, name: 'Doing', stateType: 'started', position: 2 },
            { id: 3, name: 'Done', stateType: 'completed', position: 3 }
          ]
        })
      },
      proxySession: () => null
    })

    await itsaplanListIssues({
      projectRef: 'team.M',
      filters: { stateTypes: ['unstarted', 'started'] },
      limit: 20
    })

    expect(issueUrls.map((url) => new URL(url).searchParams.get('columnId')).sort()).toEqual([
      '1',
      '2'
    ])
    expect(issueUrls.map((url) => new URL(url).searchParams.get('limit'))).toEqual(['20', '20'])
  })
})

describe('itsaplanGetIssue comments', () => {
  it('follows nextCursor and orders replies by time', async () => {
    const feedUrls: string[] = []
    setMainHttpClient({
      fetch: async (url: string) => {
        if (url.includes('/feed')) {
          feedUrls.push(url)
          return feedUrls.length === 1
            ? jsonResponse({
                items: [
                  comment(1, '2026-01-01T00:00:01.000Z'),
                  comment(3, '2026-01-01T00:00:03.000Z', 1)
                ],
                nextCursor: { ts: '2026-01-01T00:00:01.000Z', id: 1 }
              })
            : jsonResponse({
                items: [comment(2, '2026-01-01T00:00:02.000Z')],
                nextCursor: null
              })
        }
        if (url.endsWith('/projects')) {
          return jsonResponse([{ ...board.project, archivedAt: null }])
        }
        if (url.includes('/issues?')) {
          return jsonResponse([])
        }
        if (url.endsWith('/issues/7')) {
          return jsonResponse(rawIssue)
        }
        return jsonResponse(board)
      },
      proxySession: () => null
    })

    const detail = await itsaplanGetIssue({ issueId: 7 })

    expect(detail?.comments.map((entry) => entry.id)).toEqual([1, 2, 3])
    expect(feedUrls).toHaveLength(2)
    expect(decodeURIComponent(feedUrls[1])).toContain('"id":1')
  })
})

describe('itsaplanGetIssue project ref', () => {
  it('uses the caller project ref when the project index does not list it', async () => {
    setMainHttpClient({
      fetch: async (url: string) => {
        if (url.endsWith('/projects')) {
          return jsonResponse([])
        }
        if (url.endsWith('/issues/8')) {
          return jsonResponse({ ...rawIssue, id: 8, projectId: 6 })
        }
        if (url.includes('/feed')) {
          return jsonResponse({ items: [], nextCursor: null })
        }
        if (url.includes('/issues?')) {
          return jsonResponse([])
        }
        return jsonResponse({ ...board, project: { id: 6, ref: 'team.N', key: 'N', name: 'En' } })
      },
      proxySession: () => null
    })

    const detail = await itsaplanGetIssue({ issueId: 8, projectRef: 'team.N' })

    expect(detail?.projectRef).toBe('team.N')
  })
})
