import { describe, expect, it } from 'vitest'
import { mapLinearIssue } from './mappers'

describe('mapLinearIssue', () => {
  it('keeps core issue details when optional Linear relations fail', async () => {
    const issue = {
      id: 'issue-1',
      identifier: 'LIN-1',
      title: 'Investigate mobile detail',
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
      state: { name: '' },
      team: { id: '' },
      assignee: undefined,
      project: undefined
    })
  })
})
