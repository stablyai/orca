import { describe, expect, it } from 'vitest'
import {
  taskGitHubWorkItemListSchema,
  taskGitLabWorkItemListSchema,
  taskLinearIssueListSchema,
  taskWorkItemLookupSchema
} from './task-source-search-reply-schema'

// Pins the one requirement each provider read carries, and the recorded rows that decide how thin
// the row schemas are allowed to be.

describe('the provider lists require items and nothing else', () => {
  it('reads the recorded GitHub search row, which carries only number and title', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [{ number: 1, title: 'one' }] })
    expect(parsed.success && parsed.data).toMatchObject({ items: [{ number: 1, title: 'one' }] })
  })

  it('reads the recorded GitLab row, whose number lives under iid', () => {
    const parsed = taskGitLabWorkItemListSchema.safeParse({ items: [{ iid: 2, title: 'two' }] })
    expect(parsed.success && parsed.data).toMatchObject({ items: [{ iid: 2, title: 'two' }] })
  })

  it('names a list with no items, which the task screen mapped unguarded', () => {
    expect(taskGitHubWorkItemListSchema.safeParse({}).success).toBe(false)
    expect(taskGitLabWorkItemListSchema.safeParse({ error: { type: 'quota' } }).success).toBe(false)
  })

  it('keeps items alongside an in-band provider error, as the recorded reply does', () => {
    const parsed = taskGitLabWorkItemListSchema.safeParse({
      items: [{ iid: 2 }],
      error: { type: 'not_found', message: 'missing' }
    })
    expect(parsed.success && parsed.data).toMatchObject({
      items: [{ iid: 2 }],
      error: { type: 'not_found', message: 'missing' }
    })
  })

  it('passes the source banner members through without typing them', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({
      items: [],
      sources: { issues: 'upstream' },
      issueSourceFellBack: true
    })
    expect(parsed.success && parsed.data).toMatchObject({
      sources: { issues: 'upstream' },
      issueSourceFellBack: true
    })
  })

  it('drops a row that is not an object rather than failing the page', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [{ number: 1 }, 'nope'] })
    expect(parsed.success && parsed.data).toMatchObject({ items: [{ number: 1 }] })
  })
})

describe('a work-item row preserves author as a tri-state', () => {
  it('keeps an explicit null, which the row renders as "no author"', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [{ author: null }] })
    expect(parsed.success && parsed.data).toMatchObject({ items: [{ author: null }] })
  })

  it('keeps absence absent rather than collapsing it to null', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [{ number: 1 }] })
    const rows = parsed.success ? (parsed.data.items as object[]) : []
    expect('author' in rows[0]!).toBe(false)
  })
})

describe('the Linear issue list takes both shapes the picker has always accepted', () => {
  it('reads a bare array, which linear.searchIssues answers', () => {
    const parsed = taskLinearIssueListSchema.safeParse([{ id: 'issue-3' }])
    expect(parsed.success && parsed.data).toEqual([{ id: 'issue-3' }])
  })

  it('reads an items envelope, which linear.listIssues answers', () => {
    const parsed = taskLinearIssueListSchema.safeParse({ items: [{ id: 'issue-1' }] })
    expect(parsed.success && parsed.data).toEqual([{ id: 'issue-1' }])
  })

  it('reads the full recorded issue whole', () => {
    const issue = {
      id: 'issue-1',
      identifier: 'ENG-1',
      title: 'A Linear issue',
      url: '',
      description: '',
      state: { name: 'Todo', type: 'unstarted', color: '#000' },
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
      labels: [],
      priority: 0,
      updatedAt: '2020-01-01T00:00:00.000Z',
      workspaceId: 'linear-workspace'
    }
    expect(taskLinearIssueListSchema.safeParse({ items: [issue] })).toMatchObject({
      success: true,
      data: [issue]
    })
  })

  it('drops an issue with no id, which nothing could key a row on', () => {
    const parsed = taskLinearIssueListSchema.safeParse([{ identifier: 'ENG-9' }])
    expect(parsed.success && parsed.data).toEqual([])
  })

  it('names a payload that is neither shape, where main threw its own copy', () => {
    expect(taskLinearIssueListSchema.safeParse({ issues: [] }).success).toBe(false)
    expect(taskLinearIssueListSchema.safeParse('nope').success).toBe(false)
    expect(taskLinearIssueListSchema.safeParse(null).success).toBe(false)
  })
})

describe('a single work-item lookup', () => {
  it('keeps the host null for an item that does not resolve', () => {
    expect(taskWorkItemLookupSchema.safeParse(null)).toMatchObject({ success: true, data: null })
  })

  it('reads the recorded lookups, which carry no identity members', () => {
    expect(taskWorkItemLookupSchema.safeParse({ number: 12, title: 'twelve' }).success).toBe(true)
    expect(taskWorkItemLookupSchema.safeParse({ iid: 7, title: 'seven' }).success).toBe(true)
  })

  it('names a payload that is not an item at all', () => {
    expect(taskWorkItemLookupSchema.safeParse('twelve').success).toBe(false)
  })
})
