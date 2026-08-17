import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import type { ProjectShowNode } from './project-show-query'

const rawRequest = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))

vi.mock('./client', () => ({
  getClients: vi.fn(),
  isAuthError: vi.fn().mockReturnValue(false)
}))

function entry(): LinearClientForWorkspace {
  return {
    apiKey: 'lin_api_key',
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: { client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

function showNode(overrides: Partial<ProjectShowNode> = {}): ProjectShowNode {
  return {
    id: 'project-1',
    name: 'Importer',
    slugId: 'importer-abc',
    url: 'https://linear.app/acme/project/importer-abc',
    description: 'line one\r\nline two',
    content: null,
    color: '#5e6ad2',
    icon: null,
    priority: 0,
    startDate: null,
    targetDate: null,
    status: { id: 'status-1', name: 'In progress', type: 'started', color: '#0f0' },
    lead: null,
    members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    teams: {
      nodes: [{ id: 'team-1', name: 'Core', key: 'CORE' }],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ...overrides
  }
}

describe('Linear project field snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('normalizes text, keeps null content distinct and maps every editable field', async () => {
    const { completeProjectWriteRecord } = await import('./project-field-snapshot')

    const record = await completeProjectWriteRecord(entry(), showNode())

    expect(record.project).toEqual({
      id: 'project-1',
      name: 'Importer',
      slugId: 'importer-abc',
      url: 'https://linear.app/acme/project/importer-abc'
    })
    expect(record.fields).toMatchObject({
      name: 'Importer',
      description: 'line one\nline two',
      content: null,
      priority: 0,
      color: '#5e6ad2',
      icon: null,
      status: { id: 'status-1', type: 'started' },
      teams: [{ id: 'team-1', name: 'Core', key: 'CORE' }]
    })
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('pages past the first member page and keeps every id in the snapshot', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        project: {
          members: {
            nodes: [{ id: 'user-2', displayName: 'Grace', avatarUrl: null }],
            pageInfo: { hasNextPage: false, endCursor: 'c2' }
          }
        }
      }
    })
    const { completeProjectWriteRecord, linearProjectEntityIds } =
      await import('./project-field-snapshot')

    const record = await completeProjectWriteRecord(
      entry(),
      showNode({
        members: {
          nodes: [{ id: 'user-1', displayName: 'Ada', avatarUrl: null }],
          pageInfo: { hasNextPage: true, endCursor: 'c1' }
        }
      })
    )

    expect(linearProjectEntityIds(record.fields.members)).toEqual(['user-1', 'user-2'])
    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ id: 'project-1', after: 'c1' })
  })

  it('projects the internal snapshot into bounded strings and id digests', async () => {
    const { completeProjectWriteRecord, toLinearProjectFieldSnapshot } =
      await import('./project-field-snapshot')

    const record = await completeProjectWriteRecord(
      entry(),
      showNode({ description: 'Overview', content: 'Body\r\n' })
    )
    const snapshot = toLinearProjectFieldSnapshot(record.fields)

    expect(snapshot.description).toMatchObject({
      value: 'Overview',
      chars: 8,
      truncated: false
    })
    expect(snapshot.description.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.content).toMatchObject({ value: 'Body\n', chars: 5 })
    expect(snapshot.teams).toMatchObject({ returned: 1, total: 1, truncated: false })
    expect(snapshot.members).toMatchObject({ returned: 0, total: 0 })
  })

  it('publishes a null content digest that cannot collide with empty content', async () => {
    const { toLinearProjectFieldSnapshot, completeProjectWriteRecord } =
      await import('./project-field-snapshot')

    const absent = toLinearProjectFieldSnapshot(
      (await completeProjectWriteRecord(entry(), showNode({ content: null }))).fields
    )
    const empty = toLinearProjectFieldSnapshot(
      (await completeProjectWriteRecord(entry(), showNode({ content: '' }))).fields
    )

    expect(absent.content).toEqual({ value: null, truncated: false, chars: 0, sha256: '' })
    expect(empty.content.value).toBe('')
    expect(empty.content.sha256).not.toBe('')
  })

  it('compares ids as sets and text after line-ending normalization', async () => {
    const { sameLinearProjectIdSet, sameLinearProjectText } =
      await import('./project-field-snapshot')

    expect(sameLinearProjectIdSet(['b', 'a', 'a'], ['a', 'b'])).toBe(true)
    expect(sameLinearProjectIdSet(['a'], ['a', 'b'])).toBe(false)
    expect(sameLinearProjectText('one\r\ntwo', 'one\ntwo')).toBe(true)
    expect(sameLinearProjectText('', null)).toBe(false)
    expect(sameLinearProjectText(null, null)).toBe(true)
  })
})
