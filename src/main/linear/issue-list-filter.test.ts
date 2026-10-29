import { describe, expect, it } from 'vitest'
import { buildLinearListIssueFilter } from './issue-list-filter'

describe('buildLinearListIssueFilter', () => {
  it('returns undefined for all preset without attributes or team', () => {
    expect(buildLinearListIssueFilter({ filter: 'all' })).toBeUndefined()
  })

  it('merges status ids, priority, assignee, and labels for the all preset', () => {
    expect(
      buildLinearListIssueFilter({
        filter: 'all',
        attributeFilter: {
          stateIds: ['state-1', 'state-2'],
          priorities: [0, 1],
          assignee: { kind: 'user', id: 'user-1' },
          labelIds: ['label-1', 'label-2']
        }
      })
    ).toEqual({
      state: { id: { in: ['state-1', 'state-2'] } },
      priority: { in: [0, 1] },
      assignee: { id: { eq: 'user-1' } },
      labels: { some: { id: { in: ['label-1', 'label-2'] } } }
    })
  })

  it('keeps preset state.type and attribute state.id together', () => {
    expect(
      buildLinearListIssueFilter({
        filter: 'assigned',
        attributeFilter: {
          stateIds: ['state-open'],
          priorities: [],
          assignee: null,
          labelIds: []
        }
      })
    ).toEqual({
      state: {
        type: { nin: ['completed', 'canceled'] },
        id: { in: ['state-open'] }
      }
    })
  })

  it('shapes unassigned and optional team filters', () => {
    expect(
      buildLinearListIssueFilter({
        filter: 'all',
        teamId: 'team-1',
        attributeFilter: {
          stateIds: [],
          priorities: [],
          assignee: { kind: 'unassigned' },
          labelIds: []
        }
      })
    ).toEqual({
      team: { id: { eq: 'team-1' } },
      assignee: { null: true }
    })
  })

  it('omits empty attribute filters so variables match the unfiltered path', () => {
    expect(
      buildLinearListIssueFilter({
        filter: 'completed',
        attributeFilter: {
          stateIds: [],
          priorities: [],
          assignee: null,
          labelIds: []
        }
      })
    ).toEqual({
      state: { type: { in: ['completed', 'canceled'] } }
    })
  })
})
