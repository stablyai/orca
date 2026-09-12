import { describe, expect, it } from 'vitest'
import { mapRedmineIssue, mapRedmineProject, mapRedmineUser } from './mappers'

describe('redmine mappers', () => {
  it('maps a full issue payload to the shared shape', () => {
    const issue = mapRedmineIssue(
      {
        id: 106927,
        subject: 'Fix login flakiness',
        project: { id: 12, name: 'ESB' },
        tracker: { id: 1, name: 'Bug' },
        status: { id: 2, name: 'In Progress', is_closed: false },
        priority: { id: 4, name: 'High' },
        author: { id: 654, name: 'Zhuo Cheng' },
        assigned_to: { id: 219, name: 'Bao Zhu' },
        description: 'Long description',
        start_date: '2026-08-01',
        due_date: null,
        done_ratio: 40,
        estimated_hours: 8,
        spent_hours: 3.5,
        created_on: '2026-08-01T09:00:00Z',
        updated_on: '2026-08-05T10:30:00Z',
        closed_on: null,
        custom_fields: [
          { id: 29, name: 'PIC', value: '654' },
          { id: 45, name: 'AI usage', value: '90' }
        ]
      },
      'https://redmine.example.com/'
    )

    expect(issue.id).toBe(106927)
    expect(issue.subject).toBe('Fix login flakiness')
    expect(issue.project).toEqual({ id: 12, name: 'ESB' })
    expect(issue.status).toEqual({ id: 2, name: 'In Progress', isClosed: false })
    expect(issue.priority).toEqual({ id: 4, name: 'High' })
    expect(issue.author).toEqual({ id: 654, name: 'Zhuo Cheng', login: null })
    expect(issue.assignedTo).toEqual({ id: 219, name: 'Bao Zhu', login: null })
    expect(issue.doneRatio).toBe(40)
    expect(issue.estimatedHours).toBe(8)
    expect(issue.spentHours).toBe(3.5)
    expect(issue.dueDate).toBeNull()
    expect(issue.closedOn).toBeNull()
    expect(issue.customFields).toEqual([
      { id: 29, name: 'PIC', value: '654' },
      { id: 45, name: 'AI usage', value: '90' }
    ])
    expect(issue.url).toBe('https://redmine.example.com/issues/106927')
  })

  it('marks a closed status and strips trailing slash from the site URL', () => {
    const issue = mapRedmineIssue(
      {
        id: 1,
        subject: 'Done',
        status: { id: 3, name: 'Resolved', is_closed: true },
        project: { id: 1, name: 'P' },
        priority: { id: 5, name: 'Normal' },
        author: { id: 1, name: 'A' },
        created_on: '2026-01-01T00:00:00Z',
        updated_on: '2026-01-02T00:00:00Z',
        done_ratio: 100,
        closed_on: '2026-01-02T00:00:00Z'
      },
      'https://redmine.example.com///'
    )
    expect(issue.status.isClosed).toBe(true)
    expect(issue.closedOn).toBe('2026-01-02T00:00:00Z')
    expect(issue.url).toBe('https://redmine.example.com/issues/1')
  })

  it('tolerates missing optional fields', () => {
    const issue = mapRedmineIssue({ id: 7, subject: 'Bare' }, 'https://r.example')
    expect(issue.project.name).toBe('')
    expect(issue.assignedTo).toBeNull()
    expect(issue.description).toBeNull()
    expect(issue.customFields).toEqual([])
  })

  it('maps project and user helpers, returning null for empty payloads', () => {
    expect(mapRedmineProject({ id: 3, name: 'Portal', identifier: 'portal' })).toEqual({
      id: 3,
      name: 'Portal',
      identifier: 'portal'
    })
    expect(mapRedmineProject(undefined)).toBeNull()
    expect(mapRedmineUser({ id: 5, name: 'N', login: 'n' })).toEqual({
      id: 5,
      name: 'N',
      login: 'n'
    })
    expect(mapRedmineUser(undefined)).toBeNull()
  })
})
