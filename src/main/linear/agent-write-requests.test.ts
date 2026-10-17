import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import { createIssueForAgent } from './linear-issue-mutations'
import { addIssueCommentForAgent, createIssueAttachment } from './linear-issue-comments'
import { loadLinearSdk } from './linear-sdk'

const { getClients } = vi.hoisted(() => ({ getClients: vi.fn<() => LinearClientForWorkspace[]>() }))

vi.mock('./client', () => ({ getClients, isAuthError: () => false }))
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('./linear-request-concurrency', () => ({ acquire: async () => {}, release: () => {} }))

const entities = ['issue', 'comment', 'attachment'] as const
type Entity = (typeof entities)[number]
const ids = {
  issue: '33333333-3333-4333-8333-333333333333',
  comment: '44444444-4444-4444-8444-444444444444',
  attachment: '55555555-5555-4555-8555-555555555555'
}
const returnedIds = { ...ids, attachment: '66666666-6666-4666-8666-666666666666' }
const issueRef = { id: ids.issue, identifier: 'ENG-2', url: 'https://linear.app/ENG-2' }
const records = {
  issue: {
    ...issueRef,
    title: 'Follow up',
    description: 'Details',
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    state: { id: 'state-1', name: 'Todo' },
    parent: { id: 'parent-1', identifier: 'ENG-1' },
    project: { id: 'project-1', name: 'Release' },
    assignee: { id: 'user-1', displayName: 'Engineer' },
    priority: 0,
    estimate: null,
    dueDate: null,
    labelIds: ['label-1'],
    labels: { nodes: [{ id: 'label-1', name: 'Bug' }] }
  },
  comment: {
    id: ids.comment,
    url: 'https://linear.app/comment/1',
    body: 'Reply',
    parent: { id: 'thread-1' },
    issue: issueRef
  },
  attachment: {
    id: returnedIds.attachment,
    title: 'PR link',
    url: 'https://example.com/review/1',
    issue: issueRef
  }
}
const expectedRecords = {
  issue: { ...records.issue, labels: records.issue.labels.nodes },
  comment: {
    id: ids.comment,
    url: records.comment.url,
    body: 'Reply',
    issue: issueRef,
    parentId: 'thread-1',
    threadRootId: 'thread-1'
  },
  attachment: records.attachment
}
const messages = {
  issue: 'Issue was created but could not be retrieved',
  comment: 'Comment was created but could not be retrieved',
  attachment: 'Attachment was created but could not be retrieved'
}
const requests: { operation: string; variables: unknown }[] = []

function write(entity: Entity) {
  if (entity === 'issue') {
    return createIssueForAgent('team-1', 'Follow up', 'Details', 'workspace-1', {
      id: ids.issue,
      parentId: 'parent-1',
      projectId: 'project-1'
    })
  }
  if (entity === 'comment') {
    return addIssueCommentForAgent(ids.issue, 'Reply', 'workspace-1', {
      id: ids.comment,
      parentId: 'thread-1'
    })
  }
  return createIssueAttachment(
    ids.issue,
    { id: ids.attachment, title: 'PR link', url: records.attachment.url },
    'workspace-1'
  )
}

function installTransport(entity: Entity, missing?: 'payload' | 'confirmation') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== 'https://api.linear.app/graphql' || typeof init?.body !== 'string') {
        throw new Error('Unexpected SDK request')
      }
      const parsed = JSON.parse(init.body)
      const operation = /(?:mutation|query)\s+(\w+)/.exec(parsed.query)?.[1]
      if (!operation) {
        throw new Error('Missing operation')
      }
      requests.push({ operation, variables: parsed.variables })
      const mutation = operation.startsWith('create')
      const confirmation = operation.startsWith('OrcaLinear')
      const data = mutation
        ? {
            [`${entity}Create`]: {
              success: true,
              lastSyncId: 1,
              [entity]: missing === 'payload' ? null : { id: returnedIds[entity] }
            }
          }
        : {
            [entity]: confirmation
              ? missing === 'confirmation'
                ? null
                : records[entity]
              : {
                  ...records[entity],
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                  reactions: [],
                  sharedAccess: { isShared: false, sharedWithUsers: [] }
                }
          }
      return new Response(JSON.stringify({ data }), {
        headers: { 'content-type': 'application/json' }
      })
    })
  )
}

beforeEach(() => {
  requests.length = 0
  getClients.mockReturnValue([
    {
      workspace: {
        id: 'workspace-1',
        organizationId: 'org-1',
        organizationName: 'Example',
        displayName: 'Agent',
        email: null
      },
      client: new (loadLinearSdk().LinearClient)({ apiKey: 'orca-offline-write-test' }),
      apiKey: 'orca-offline-write-test'
    }
  ])
})
afterEach(() => vi.unstubAllGlobals())

describe('agent write payload IDs through the shipping Linear SDK', () => {
  it.each(entities)('confirms the complete %s record in two requests', async (entity) => {
    installTransport(entity)
    await expect(write(entity)).resolves.toEqual(expectedRecords[entity])
    expect(requests).toHaveLength(2)
    const entityName = entity[0].toUpperCase() + entity.slice(1)
    expect(requests.map((request) => request.operation)).toEqual([
      `create${entityName}`,
      `OrcaLinear${entityName}ByUuid`
    ])
    expect(requests[0].variables).toMatchObject({ input: { id: ids[entity] } })
    expect(requests.at(-1)?.variables).toEqual({ id: returnedIds[entity] })
  })

  it.each(entities)('keeps missing %s payload IDs unconfirmed', async (entity) => {
    installTransport(entity, 'payload')
    await expect(write(entity)).rejects.toMatchObject({
      kind: 'unconfirmed',
      message: messages[entity]
    })
    expect(requests).toHaveLength(1)
  })

  it.each(entities)('keeps missing final %s confirmation unconfirmed', async (entity) => {
    installTransport(entity, 'confirmation')
    await expect(write(entity)).rejects.toMatchObject({
      kind: 'unconfirmed',
      message: messages[entity]
    })
    expect(requests).toHaveLength(2)
    expect(requests.at(-1)?.variables).toEqual({ id: returnedIds[entity] })
  })
})
