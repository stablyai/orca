import { describe, expect, it } from 'vitest'
import {
  taskGitHubWorkItemListSchema,
  taskGitLabWorkItemListSchema,
  taskLinearIssueListSchema,
  taskWorkItemLookupSchema
} from './task-source-search-reply-schema'

// Pins what each provider read requires and, for every requirement, the drop a row takes when the
// host omits it. The rows here are the corrected fixtures: real GitHubWorkItem / GitLabWorkItem /
// LinearIssue shapes, not the `{ id }` and `{ number, title }` stubs the corpus used to carry.

const githubRow = {
  id: 'issue:1',
  type: 'issue',
  number: 1,
  title: 'one',
  state: 'open',
  url: '',
  labels: [],
  updatedAt: '2020-01-01T00:00:00.000Z',
  author: null
}

const linearRow = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'A Linear issue',
  url: '',
  state: { name: 'Todo', type: 'unstarted', color: '#000' },
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  labels: [],
  priority: 0,
  updatedAt: '2020-01-01T00:00:00.000Z',
  workspaceId: 'linear-workspace'
}

describe('the provider lists require items, and a row requires its labels', () => {
  it('reads the recorded GitHub search row whole', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [githubRow] })
    expect(parsed.success && parsed.data).toMatchObject({ items: [githubRow] })
  })

  it('reads the recorded GitLab row whole', () => {
    const row = { ...githubRow, id: 'issue:2', number: 2, title: 'two', state: 'opened' }
    const parsed = taskGitLabWorkItemListSchema.safeParse({ items: [row] })
    expect(parsed.success && parsed.data).toMatchObject({ items: [row] })
  })

  it('names a list with no items, which the task screen mapped unguarded', () => {
    expect(taskGitHubWorkItemListSchema.safeParse({}).success).toBe(false)
    expect(taskGitLabWorkItemListSchema.safeParse({ error: { type: 'quota' } }).success).toBe(false)
  })

  it('drops a row with no labels, which both label editors filter unguarded', () => {
    const { labels: _labels, ...noLabels } = githubRow
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [githubRow, noLabels] })
    expect(parsed.success && parsed.data).toMatchObject({ items: [githubRow] })
  })

  it('drops a row whose labels are not an array, rather than handing filter a string', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({
      items: [{ ...githubRow, labels: 'bug' }]
    })
    expect(parsed.success && parsed.data).toMatchObject({ items: [] })
  })

  it('drops a non-string label and keeps the row, because every reader compares it as text', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({
      items: [{ ...githubRow, labels: ['bug', 7] }]
    })
    expect(parsed.success && parsed.data).toMatchObject({ items: [{ labels: ['bug'] }] })
  })

  it('keeps items alongside an in-band provider error, as the recorded reply does', () => {
    const parsed = taskGitLabWorkItemListSchema.safeParse({
      items: [githubRow],
      error: { type: 'not_found', message: 'missing' }
    })
    expect(parsed.success && parsed.data).toMatchObject({
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
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [githubRow, 'nope'] })
    expect(parsed.success && parsed.data).toMatchObject({ items: [githubRow] })
  })
})

describe('a work-item row preserves author as a tri-state', () => {
  it('keeps an explicit null, which the row renders as "no author"', () => {
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [githubRow] })
    expect(JSON.stringify(parsed)).toContain('"author":null')
  })

  it('keeps absence absent rather than collapsing it to null', () => {
    const { author: _author, ...noAuthor } = githubRow
    const parsed = taskGitHubWorkItemListSchema.safeParse({ items: [noAuthor] })
    const row = parsed.success ? parsed.data.items[0] : undefined
    expect(row && 'author' in row).toBe(false)
  })
})

describe('the Linear issue list takes both shapes the picker has always accepted', () => {
  it('reads a bare array, which linear.searchIssues answers', () => {
    const parsed = taskLinearIssueListSchema.safeParse([linearRow])
    expect(parsed.success && parsed.data).toEqual([linearRow])
  })

  it('reads an items envelope, which linear.listIssues answers', () => {
    const parsed = taskLinearIssueListSchema.safeParse({ items: [linearRow] })
    expect(parsed.success && parsed.data).toEqual([linearRow])
  })

  it('drops an issue with no id, which nothing could key a row on', () => {
    const { id: _id, ...noId } = linearRow
    expect(taskLinearIssueListSchema.safeParse([noId])).toMatchObject({ success: true, data: [] })
  })

  // The four reads createLinearTask and the reviewer sort make with no guard. Each drops its row
  // rather than crashing the map, and each drop is the behaviour the fixture correction records.
  it('drops an issue with no state, which createLinearTask reads as state.name', () => {
    const { state: _state, ...noState } = linearRow
    expect(taskLinearIssueListSchema.safeParse([noState])).toMatchObject({ data: [] })
  })

  it('drops an issue with no team, which createLinearTask reads as team.name', () => {
    const { team: _team, ...noTeam } = linearRow
    expect(taskLinearIssueListSchema.safeParse([noTeam])).toMatchObject({ data: [] })
  })

  it('drops an issue whose state carries no name, not just one with no state at all', () => {
    const parsed = taskLinearIssueListSchema.safeParse([
      { ...linearRow, state: { type: 'unstarted', color: '#000' } }
    ])
    expect(parsed).toMatchObject({ data: [] })
  })

  it('drops an issue whose team carries no name', () => {
    const parsed = taskLinearIssueListSchema.safeParse([
      { ...linearRow, team: { id: 'team-1', key: 'ENG' } }
    ])
    expect(parsed).toMatchObject({ data: [] })
  })

  it('drops an issue with no priority, which would make the reviewer comparator NaN', () => {
    const { priority: _priority, ...noPriority } = linearRow
    expect(taskLinearIssueListSchema.safeParse([noPriority])).toMatchObject({ data: [] })
  })

  // Adopting the item half's `linearIssueRowSchema` adds five requirements to this path. Each one
  // is non-optional on the host's own `LinearIssue`, and each is rendered by the picker row.
  it.each(['identifier', 'title', 'url', 'updatedAt', 'labels'])(
    'drops an issue with no %s, which the host type declares non-optional',
    (member) => {
      const { [member]: _dropped, ...without } = linearRow
      expect(taskLinearIssueListSchema.safeParse([without])).toMatchObject({ data: [] })
    }
  )

  it('keeps the rest of the page when one row drops', () => {
    const { state: _state, ...noState } = linearRow
    const parsed = taskLinearIssueListSchema.safeParse([linearRow, noState])
    expect(parsed.success && parsed.data).toEqual([linearRow])
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

  it('reads the corrected lookup row whole', () => {
    expect(taskWorkItemLookupSchema.safeParse(githubRow)).toMatchObject({ success: true })
  })

  // Not a drop: a lookup is one row, not a list, so an unreadable row names the reply instead of
  // handing the paste a source whose labels the editor would then filter.
  it('names a lookup row with no labels rather than resolving the paste', () => {
    const { labels: _labels, ...noLabels } = githubRow
    expect(taskWorkItemLookupSchema.safeParse(noLabels).success).toBe(false)
  })

  it('names a payload that is not an item at all', () => {
    expect(taskWorkItemLookupSchema.safeParse('twelve').success).toBe(false)
  })
})
