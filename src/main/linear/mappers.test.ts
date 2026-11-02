import { describe, expect, it } from 'vitest'
import { mapLinearIssue, mapLinearLinkedPullRequests } from './mappers'

describe('mapLinearIssue', () => {
  it('keeps core issue details when optional Linear relations fail', async () => {
    const issue = {
      id: 'issue-1',
      identifier: 'LIN-1',
      title: 'Investigate mobile detail',
      branchName: 'team/lin-1-investigate-mobile-detail',
      description: 'Body',
      url: 'https://linear.app/acme/issue/LIN-1',
      estimate: 2,
      priority: 1,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      state: Promise.reject(new Error('state fetch failed')),
      team: Promise.reject(new Error('team fetch failed')),
      assignee: Promise.reject(new Error('assignee fetch failed')),
      project: Promise.reject(new Error('project fetch failed')),
      labels: async () => ({
        nodes: [{ id: 'label-1', name: 'Bug' }]
      }),
      children: async () => ({
        nodes: [
          {
            id: 'child-1',
            identifier: 'LIN-2',
            title: 'Child',
            url: 'https://linear.app/acme/issue/LIN-2'
          }
        ]
      })
    }

    await expect(
      mapLinearIssue(issue as never, { includeChildren: true, includeProject: true })
    ).resolves.toMatchObject({
      id: 'issue-1',
      identifier: 'LIN-1',
      title: 'Investigate mobile detail',
      labels: ['Bug'],
      subIssues: [{ id: 'child-1', identifier: 'LIN-2' }],
      branchName: 'team/lin-1-investigate-mobile-detail',
      state: { name: '' },
      team: { id: '' },
      assignee: undefined,
      project: undefined
    })
  })
})

describe('mapLinearLinkedPullRequests', () => {
  it('keeps only GitHub PR and GitLab MR attachments', () => {
    expect(
      mapLinearLinkedPullRequests([
        {
          id: 'a-1',
          title: 'feat: add PR links',
          url: 'https://github.com/acme/app/pull/42',
          subtitle: 'Open'
        },
        {
          id: 'a-2',
          title: 'fix: MR',
          url: 'https://gitlab.com/acme/group/app/-/merge_requests/7',
          subtitle: null
        },
        { id: 'a-3', title: 'Issue', url: 'https://github.com/acme/app/issues/42' },
        { id: 'a-4', title: 'Commit', url: 'https://github.com/acme/app/commit/abc123' },
        { id: 'a-5', title: 'Doc', url: 'https://docs.google.com/document/d/1' },
        { id: 'a-6', title: 'Spoof', url: 'https://github.com.evil.dev/acme/app/pull/1' }
      ])
    ).toEqual([
      {
        id: 'a-1',
        title: 'feat: add PR links',
        url: 'https://github.com/acme/app/pull/42',
        subtitle: 'Open'
      },
      {
        id: 'a-2',
        title: 'fix: MR',
        url: 'https://gitlab.com/acme/group/app/-/merge_requests/7',
        subtitle: undefined
      }
    ])
  })
})
