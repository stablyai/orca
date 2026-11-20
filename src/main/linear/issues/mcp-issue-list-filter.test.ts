import { describe, expect, it } from 'vitest'
import { buildIssueFilter } from './mcp-issue-list-filter'

describe('buildIssueFilter state', () => {
  it('reads open as every state not done or canceled', () => {
    expect(buildIssueFilter({ state: 'open' })).toEqual({
      state: { type: { nin: ['completed', 'canceled'] } }
    })
  })

  it('still matches a state by name or type', () => {
    expect(buildIssueFilter({ state: 'started' })).toEqual({
      state: { or: [{ name: { eqIgnoreCase: 'started' } }, { type: { eqIgnoreCase: 'started' } }] }
    })
  })
})
