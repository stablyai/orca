import { describe, expect, it } from 'vitest'
import { buildIssueFilter } from './mcp-issue-list-filter'

const CYCLE_ID = '89f28b14-0eaa-4364-bfbb-d860ab46178f'

describe('buildIssueFilter cycle', () => {
  it('maps current and active to the active cycle', () => {
    expect(buildIssueFilter({ cycle: 'current' })).toEqual({
      cycle: { isActive: { eq: true } }
    })
    expect(buildIssueFilter({ cycle: 'active' })).toEqual({
      cycle: { isActive: { eq: true } }
    })
  })

  it('maps previous and next to the neighbouring cycles', () => {
    expect(buildIssueFilter({ cycle: 'previous' })).toEqual({
      cycle: { isPrevious: { eq: true } }
    })
    expect(buildIssueFilter({ cycle: 'next' })).toEqual({
      cycle: { isNext: { eq: true } }
    })
  })

  it('matches keywords regardless of letter case', () => {
    expect(buildIssueFilter({ cycle: 'Current' })).toEqual({
      cycle: { isActive: { eq: true } }
    })
    expect(buildIssueFilter({ cycle: 'NEXT' })).toEqual({
      cycle: { isNext: { eq: true } }
    })
  })

  it('maps a digits-only value to the cycle number', () => {
    expect(buildIssueFilter({ cycle: '20' })).toEqual({
      cycle: { number: { eq: 20 } }
    })
  })

  it('keeps null selecting issues without a cycle', () => {
    expect(buildIssueFilter({ cycle: 'null' })).toEqual({ cycle: { null: true } })
  })

  it('keeps matching a cycle id or a custom cycle name', () => {
    expect(buildIssueFilter({ cycle: CYCLE_ID })).toEqual({
      cycle: { or: [{ id: { eq: CYCLE_ID } }, { name: { eqIgnoreCase: CYCLE_ID } }] }
    })
    expect(buildIssueFilter({ cycle: 'Sprint 20' })).toEqual({
      cycle: { or: [{ name: { eqIgnoreCase: 'Sprint 20' } }] }
    })
  })

  it('combines the cycle keyword with other facets', () => {
    expect(buildIssueFilter({ cycle: 'current', team: 'ENG', assignee: 'me' })).toEqual({
      team: { or: [{ name: { eqIgnoreCase: 'ENG' } }, { key: { eqIgnoreCase: 'ENG' } }] },
      cycle: { isActive: { eq: true } },
      assignee: { isMe: { eq: true } }
    })
  })
})
