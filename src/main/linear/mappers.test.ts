import { describe, expect, it, vi } from 'vitest'
import { mapLinearIssue } from './mappers'

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

  it('retains only requested lazy-relation rows when the SDK returns extra nodes', async () => {
    const labels = vi.fn().mockResolvedValue({
      nodes: Array.from({ length: 51 }, (_, index) => ({
        id: `label-${index}`,
        name: `Label ${index}`
      }))
    })
    const children = vi.fn().mockResolvedValue({
      nodes: Array.from({ length: 26 }, (_, index) => ({
        id: `child-${index}`,
        identifier: `LIN-${index}`,
        title: `Child ${index}`,
        url: `https://linear.app/child-${index}`
      }))
    })
    const issue = {
      id: 'issue-1',
      identifier: 'LIN-1',
      title: 'Bound relations',
      description: null,
      url: 'https://linear.app/LIN-1',
      estimate: null,
      priority: 0,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      state: null,
      team: null,
      assignee: null,
      labels,
      children
    }

    const mapped = await mapLinearIssue(issue as never, { includeChildren: true })

    expect(mapped.labels).toHaveLength(50)
    expect(mapped.labelIds).toHaveLength(50)
    expect(mapped.subIssues).toHaveLength(25)
    expect(labels).toHaveBeenCalledWith({ first: 50 })
    expect(children).toHaveBeenCalledWith({ first: 25 })
  })
})
