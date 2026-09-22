import { describe, expect, it } from 'vitest'
import { mapIssue, pickSearchIssue } from './issue-context-raw'

describe('Linear search issue summaries', () => {
  it('carries priorityLabel from the numeric priority through pickSearchIssue', () => {
    const summary = pickSearchIssue(
      mapIssue({
        id: 'issue-1',
        identifier: 'ENG-1',
        title: 'Fix auth',
        url: 'https://linear.app/acme/issue/ENG-1',
        labels: { nodes: [] },
        priority: 1
      })
    )

    expect(summary.priority).toBe(1)
    expect(summary.priorityLabel).toBe('urgent')
  })
})
