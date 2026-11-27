import { describe, expect, it } from 'vitest'
import {
  mapItsaplanComment,
  mapItsaplanIssue,
  mapItsaplanProjectMetadata,
  type ItsaplanRawIssue
} from './itsaplan-issue-mapping'

const metadata = mapItsaplanProjectMetadata(
  { id: 5, ref: 'team.MKT', key: 'MKT', name: 'Marketing' },
  [{ id: 3, name: 'Doing', stateType: 'started', position: 1 }],
  [{ id: 1, name: 'bug', color: '#f00' }],
  [{ userId: 'u1', name: 'Ana', kind: 'member' }]
)

function rawIssue(overrides: Partial<ItsaplanRawIssue> = {}): ItsaplanRawIssue {
  return {
    id: 678,
    sequenceNumber: 42,
    identifier: 'MKT-42',
    columnId: 3,
    assigneeUserId: 'u1',
    delegateUserId: null,
    parentId: null,
    title: 'Ship it',
    description: '',
    priority: null,
    labelIds: [1, 99],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides
  }
}

describe('mapItsaplanIssue', () => {
  it('resolves state, labels, assignee and url from metadata', () => {
    const issue = mapItsaplanIssue(rawIssue(), { metadata, appUrl: 'https://app.example.com' })
    expect(issue.state).toEqual({ columnId: 3, name: 'Doing', stateType: 'started' })
    expect(issue.labels).toEqual([{ id: 1, name: 'bug', color: '#f00' }])
    expect(issue.assignee).toEqual({ userId: 'u1', name: 'Ana', isAgent: false })
    expect(issue.url).toBe('https://app.example.com/issue/678')
    expect(issue.priority).toBeNull()
    expect(issue.projectRef).toBe('team.MKT')
  })

  it('falls back for an unknown column and an unknown assignee', () => {
    const issue = mapItsaplanIssue(rawIssue({ columnId: 77, assigneeUserId: 'ghost' }), {
      metadata,
      appUrl: 'https://app.example.com'
    })
    expect(issue.state).toEqual({ columnId: 77, name: 'Unknown', stateType: 'unstarted' })
    expect(issue.assignee).toEqual({ userId: 'ghost', name: 'ghost', isAgent: false })
  })

  it('maps a list hit that carries no description', () => {
    const { description: _omitted, ...hit } = rawIssue()
    const issue = mapItsaplanIssue(hit, { metadata, appUrl: 'https://app.example.com' })
    expect(issue.description).toBe('')
  })
})

describe('mapItsaplanProjectMetadata', () => {
  it('marks agents and drops other project fields', () => {
    const mapped = mapItsaplanProjectMetadata(
      { id: 5, ref: 'team.MKT', key: 'MKT', name: 'Marketing' },
      [],
      [],
      [{ userId: 'a1', name: 'Bot', kind: 'agent' }]
    )
    expect(mapped.members).toEqual([{ userId: 'a1', name: 'Bot', isAgent: true }])
    expect(mapped.project).toEqual({ id: 5, ref: 'team.MKT', key: 'MKT', name: 'Marketing' })
  })
})

describe('mapItsaplanComment', () => {
  it('maps a comment and ignores activity entries', () => {
    expect(
      mapItsaplanComment({
        id: 9,
        kind: 'comment',
        body: 'hi',
        actorUserId: 'u1',
        actorName: 'Ana',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
    ).toEqual({
      id: 9,
      body: 'hi',
      author: { userId: 'u1', name: 'Ana' },
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    expect(
      mapItsaplanComment({
        id: 10,
        kind: 'activity',
        body: null,
        actorUserId: 'u1',
        actorName: 'Ana',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
    ).toBeNull()
  })
})
