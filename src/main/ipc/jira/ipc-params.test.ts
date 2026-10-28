import { describe, expect, it } from 'vitest'
import {
  clampJiraIssueLimit,
  normalizeJiraIssueUpdate,
  normalizeJiraSiteId,
  normalizeJiraSiteSelection
} from './ipc-params'

describe('Jira IPC parameters', () => {
  it('preserves normalized sites and all-sites selection', () => {
    expect(normalizeJiraSiteId(' site-1 ')).toBe('site-1')
    expect(normalizeJiraSiteSelection(' all ')).toBe('all')
    for (const value of [undefined, null, 1, {}, '', '  ']) {
      expect(normalizeJiraSiteSelection(value)).toBeUndefined()
    }
  })

  it('bounds issue reads and rejects nonfinite limits', () => {
    expect(clampJiraIssueLimit(0)).toBe(1)
    expect(clampJiraIssueLimit(1_000_000)).toBe(100)
    expect(clampJiraIssueLimit(50)).toBe(50)
    for (const value of [undefined, '100', Number.NaN, Infinity, -Infinity]) {
      expect(clampJiraIssueLimit(value)).toBe(30)
    }
  })

  it('preserves supported issue edits including clears and transition fields', () => {
    const updates = {
      title: '',
      labels: [],
      assigneeAccountId: null,
      priorityId: null,
      transitionId: '31',
      transitionFields: { resolution: { id: '1' } },
      transitionComment: 'Verified'
    }
    expect(normalizeJiraIssueUpdate(updates)).toEqual(updates)
    expect(
      normalizeJiraIssueUpdate({ labelOperations: { add: ['new'], remove: ['old'] } })
    ).toEqual({ labelOperations: { add: ['new'], remove: ['old'] } })
    expect(normalizeJiraIssueUpdate({})).toEqual({})
  })

  it.each([
    null,
    [],
    'title',
    { title: 1 },
    { labels: 'label' },
    { labels: ['label', 1] },
    { assigneeAccountId: {} },
    { priorityId: false },
    { transitionId: null },
    { transitionFields: [] },
    { transitionFields: null },
    { transitionComment: 1 },
    { labelOperations: null },
    { labelOperations: [] },
    { labelOperations: 1 },
    { labelOperations: { add: 'label' } },
    { labelOperations: { remove: [1] } }
  ])('rejects malformed edits before they reach Jira: %j', (value) => {
    expect(normalizeJiraIssueUpdate(value)).toBeNull()
  })
})
