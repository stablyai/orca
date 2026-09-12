import { describe, expect, it } from 'vitest'
import { mapIssueWorkItem } from './work-item'

describe('mapIssueWorkItem blockedByCount', () => {
  it('maps REST issue_dependencies_summary.blocked_by', () => {
    const item = mapIssueWorkItem({
      number: 12,
      title: 'Blocked work',
      state: 'open',
      html_url: 'https://github.com/acme/widgets/issues/12',
      labels: [],
      updated_at: '2026-03-29T00:00:00Z',
      user: { login: 'octocat' },
      issue_dependencies_summary: {
        blocked_by: 2,
        blocking: 0,
        total_blocked_by: 2,
        total_blocking: 0
      }
    })
    expect(item.blockedByCount).toBe(2)
  })

  it('maps gh blockedBy open nodes and ignores totalCount', () => {
    const item = mapIssueWorkItem({
      number: 12,
      title: 'Blocked work',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/12',
      labels: [],
      updatedAt: '2026-03-29T00:00:00Z',
      author: { login: 'octocat' },
      blockedBy: {
        totalCount: 1,
        nodes: [
          {
            number: 11,
            title: 'Schema migration',
            url: 'https://github.com/acme/widgets/issues/11',
            state: 'OPEN'
          }
        ]
      }
    })
    expect(item.blockedByCount).toBe(1)
    expect(item.blockedBy).toEqual([
      {
        number: 11,
        title: 'Schema migration',
        url: 'https://github.com/acme/widgets/issues/11'
      }
    ])
  })

  it('does not treat closed-only blockers as currently blocked', () => {
    const item = mapIssueWorkItem({
      number: 12,
      title: 'Unblocked work',
      state: 'open',
      url: 'https://github.com/acme/widgets/issues/12',
      labels: [],
      updatedAt: '2026-03-29T00:00:00Z',
      author: { login: 'octocat' },
      blockedBy: {
        totalCount: 1,
        nodes: [
          {
            number: 11,
            title: 'Already shipped',
            url: 'https://github.com/acme/widgets/issues/11',
            state: 'CLOSED'
          }
        ]
      }
    })
    expect(item.blockedByCount).toBe(0)
    expect(item.blockedBy).toBeUndefined()
  })

  it('prefers summary open count over closed nodes in blockedBy', () => {
    const item = mapIssueWorkItem({
      number: 12,
      title: 'Still blocked',
      state: 'open',
      html_url: 'https://github.com/acme/widgets/issues/12',
      labels: [],
      updated_at: '2026-03-29T00:00:00Z',
      user: { login: 'octocat' },
      issue_dependencies_summary: {
        blocked_by: 1,
        blocking: 0,
        total_blocked_by: 2,
        total_blocking: 0
      },
      blockedBy: {
        totalCount: 2,
        nodes: [
          {
            number: 10,
            title: 'Closed blocker',
            url: 'https://github.com/acme/widgets/issues/10',
            state: 'CLOSED'
          },
          {
            number: 11,
            title: 'Open blocker',
            url: 'https://github.com/acme/widgets/issues/11',
            state: 'OPEN'
          }
        ]
      }
    })
    expect(item.blockedByCount).toBe(1)
    expect(item.blockedBy).toEqual([
      {
        number: 11,
        title: 'Open blocker',
        url: 'https://github.com/acme/widgets/issues/11'
      }
    ])
  })

  it('omits blockedByCount when the summary is absent', () => {
    const item = mapIssueWorkItem({
      number: 12,
      title: 'Plain work',
      state: 'open',
      html_url: 'https://github.com/acme/widgets/issues/12',
      labels: [],
      updated_at: '2026-03-29T00:00:00Z',
      user: { login: 'octocat' }
    })
    expect(item.blockedByCount).toBeUndefined()
  })
})
