import { describe, expect, it } from 'vitest'
import {
  PROJECT_OWNER_TYPE,
  taskProjectAccessibleListSchema,
  taskProjectAssignableUserListSchema,
  taskProjectCommentMutationSchema,
  taskProjectCommentWriteSchema,
  taskProjectIssueTypeListSchema,
  taskProjectLabelListSchema,
  taskProjectMutationStatusSchema,
  taskProjectRefSchema,
  taskProjectRowDetailSchema,
  taskProjectViewListSchema,
  taskProjectViewTableSchema
} from './task-project-board-reply-schema'

// Pins the decisions task-project-board-reply-schema.ts documents: the one closed enum, the one
// open-vocabulary string beside it, the row drops, and the tri-state the detail pane forwards.

describe('project envelopes', () => {
  it('reads the recorded accessible-project list whole', () => {
    const parsed = taskProjectAccessibleListSchema.safeParse({
      ok: true,
      projects: [
        { owner: 'owner', ownerType: 'organization', number: 3, title: 'Board', host: 'github.com' }
      ],
      partialFailures: []
    })
    expect(parsed.success && parsed.data).toEqual({
      ok: true,
      projects: [
        { owner: 'owner', ownerType: 'organization', number: 3, title: 'Board', host: 'github.com' }
      ],
      partialFailures: []
    })
  })

  it('drops a project row with no title, which the picker search lowercases unguarded', () => {
    const row = { owner: 'owner', ownerType: 'organization', number: 3, title: 'Board' }
    const { title: _title, ...noTitle } = row
    const parsed = taskProjectAccessibleListSchema.safeParse({
      ok: true,
      projects: [row, noTitle]
    })
    expect(parsed.success && parsed.data).toMatchObject({ projects: [row] })
  })

  it('requires the message the refusal arm is thrown with', () => {
    const parsed = taskProjectAccessibleListSchema.safeParse({
      ok: false,
      error: { type: 'not_found', message: 'gone' }
    })
    expect(parsed.success && parsed.data).toMatchObject({ ok: false, error: { message: 'gone' } })
  })

  it('refuses an envelope with no ok, which main read as a property access on undefined', () => {
    expect(taskProjectAccessibleListSchema.safeParse({ projects: [] }).success).toBe(false)
    expect(taskProjectAccessibleListSchema.safeParse(null).success).toBe(false)
  })
})

describe('ownerType is a closed enum', () => {
  it('takes both arms the host validates', () => {
    // The arm list is pinned to GitHubProjectOwnerType in the schema module, where tsc looks; this
    // loop proves every pinned arm parses rather than dropping the row that carries it.
    for (const ownerType of PROJECT_OWNER_TYPE) {
      const parsed = taskProjectRefSchema.safeParse({ ok: true, owner: 'o', ownerType, number: 3 })
      expect(parsed.success && parsed.data).toMatchObject({ ownerType })
    }
  })

  it('refuses an arm it does not know, because the value is echoed into listViews params', () => {
    const parsed = taskProjectRefSchema.safeParse({
      ok: true,
      owner: 'o',
      ownerType: 'enterprise',
      number: 3
    })
    expect(parsed.success).toBe(false)
  })

  it('drops a project row carrying an unknown ownerType rather than failing the list', () => {
    const parsed = taskProjectAccessibleListSchema.safeParse({
      ok: true,
      projects: [
        { owner: 'a', ownerType: 'organization', number: 1, title: 'A' },
        { owner: 'b', ownerType: 'enterprise', number: 2, title: 'B' }
      ]
    })
    expect(parsed.success && parsed.data).toMatchObject({
      projects: [{ owner: 'a', ownerType: 'organization', number: 1, title: 'A' }]
    })
  })
})

describe('layout stays an open vocabulary', () => {
  it('keeps a view whose layout this build has never heard of', () => {
    const parsed = taskProjectViewListSchema.safeParse({
      ok: true,
      views: [{ id: 'v1', number: 1, name: 'Timeline', layout: 'TIMELINE_LAYOUT' }]
    })
    expect(parsed.success && parsed.data).toMatchObject({
      views: [{ id: 'v1', layout: 'TIMELINE_LAYOUT' }]
    })
  })

  it('drops a view with no id, which nothing could have selected', () => {
    const parsed = taskProjectViewListSchema.safeParse({
      ok: true,
      views: [{ number: 1, layout: 'TABLE_LAYOUT' }]
    })
    expect(parsed.success && parsed.data).toMatchObject({ views: [] })
  })
})

describe('the board table', () => {
  it('reads the recorded table, whose project carries only id/title/number', () => {
    const parsed = taskProjectViewTableSchema.safeParse({
      ok: true,
      data: {
        project: { id: 'project-1', title: 'Board', number: 3 },
        selectedView: { id: 'view-1', number: 1, name: 'Table', filter: 'is:open' },
        fields: [],
        rows: []
      }
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a table with no selectedView, which was a read on undefined', () => {
    const parsed = taskProjectViewTableSchema.safeParse({
      ok: true,
      data: { project: { id: 'p' }, rows: [] }
    })
    expect(parsed.success).toBe(false)
  })
})

describe('the row detail pane preserves reviewDecision as a tri-state', () => {
  const detail = (item: unknown) =>
    taskProjectRowDetailSchema.safeParse({ ok: true, details: { item } })

  it('keeps an explicit null', () => {
    const parsed = detail({ reviewDecision: null })
    expect(parsed.success && parsed.data).toMatchObject({
      details: { item: { reviewDecision: null } }
    })
    // JSON drops an absent key and keeps an explicit null, which is the whole distinction here.
    expect(JSON.stringify(parsed)).toContain('"reviewDecision":null')
  })

  it('keeps absence absent rather than collapsing it to null', () => {
    const parsed = detail({ labels: [] })
    expect(JSON.stringify(parsed)).not.toContain('reviewDecision')
  })

  it('keeps a decision the host reports', () => {
    const parsed = detail({ reviewDecision: 'APPROVED' })
    expect(parsed.success && parsed.data).toMatchObject({
      details: { item: { reviewDecision: 'APPROVED' } }
    })
  })
})

describe('the guarded reads require nothing but the container', () => {
  it('accepts a label list with no ok and no labels, which main read as a refusal', () => {
    expect(taskProjectLabelListSchema.safeParse({}).success).toBe(true)
    expect(taskProjectLabelListSchema.safeParse(null).success).toBe(false)
  })

  it('drops a non-string label rather than failing the picker', () => {
    const parsed = taskProjectLabelListSchema.safeParse({ ok: true, labels: ['bug', 7] })
    expect(parsed.success && parsed.data).toMatchObject({ labels: ['bug'] })
  })

  it('drops an issue type with no id, which the write could not have sent', () => {
    const parsed = taskProjectIssueTypeListSchema.safeParse({
      ok: true,
      types: [{ id: 'type-1', name: 'Bug' }, { name: 'Task' }]
    })
    expect(parsed.success && parsed.data).toMatchObject({ types: [{ id: 'type-1', name: 'Bug' }] })
  })

  it('names the b2 seed null reply instead of reading .ok off it', () => {
    expect(taskProjectMutationStatusSchema.safeParse(null).success).toBe(false)
    expect(taskProjectMutationStatusSchema.safeParse({ ok: true }).success).toBe(true)
  })
})

describe('the comment replies', () => {
  it('keeps the recorded numeric comment id', () => {
    const parsed = taskProjectCommentWriteSchema.safeParse({
      ok: true,
      comment: { id: 906, author: 'You', body: 'a project comment' }
    })
    expect(parsed.success && parsed.data).toMatchObject({ comment: { id: 906 } })
  })

  it('drops a comment with no id rather than appending an unkeyed row', () => {
    const parsed = taskProjectCommentWriteSchema.safeParse({ ok: true, comment: { body: 'hi' } })
    expect(parsed.success && parsed.data).toEqual({ ok: true })
  })

  it('keeps a bare-string error, which both mutation call sites branch on', () => {
    const parsed = taskProjectCommentMutationSchema.safeParse({ ok: false, error: 'nope' })
    expect(parsed.success && parsed.data).toMatchObject({ ok: false, error: 'nope' })
  })

  it('keeps an enveloped error too', () => {
    const parsed = taskProjectCommentMutationSchema.safeParse({
      ok: false,
      error: { message: 'nope' }
    })
    expect(parsed.success && parsed.data).toMatchObject({ error: { message: 'nope' } })
  })
})

// The five collections and the assignee list are typed by the item half's entity schemas now, so a
// row the pane would have crashed on drops instead of reaching a consumer as the declared type.
// No scenario reply carries any of them non-empty, so these pins are the only thing that observes
// the change — the goldens cannot.
describe('the detail collections are the shared entity rows', () => {
  const details = (value: Record<string, unknown>) =>
    taskProjectRowDetailSchema.safeParse({ ok: true, details: value })

  it('drops a comment with no body, which the thread renders unguarded', () => {
    const parsed = details({ comments: [{ id: 1, body: 'kept' }, { id: 2 }] })
    expect(parsed.success && parsed.data).toMatchObject({
      details: { comments: [{ id: 1, body: 'kept' }] }
    })
  })

  it('drops a reviewer with no login, which the merge reads as `login.trim()`', () => {
    const parsed = details({ item: { reviewRequests: [{ login: 'octocat' }, { name: 'nobody' }] } })
    expect(parsed.success && parsed.data).toMatchObject({
      details: { item: { reviewRequests: [{ login: 'octocat' }] } }
    })
  })

  it('keeps a reviewer row null name and avatar rather than collapsing them', () => {
    const parsed = details({
      item: { reviewRequests: [{ login: 'octocat', name: null, avatarUrl: null }] }
    })
    expect(JSON.stringify(parsed)).toContain('"name":null')
    expect(JSON.stringify(parsed)).toContain('"avatarUrl":null')
  })

  it('drops a review with no login and a check with no name', () => {
    const reviews = details({ item: { latestReviews: [{ state: 'APPROVED' }] } })
    expect(reviews.success && reviews.data).toMatchObject({
      details: { item: { latestReviews: [] } }
    })
    const checks = details({
      checks: [{ name: 'build', status: 'COMPLETED' }, { status: 'QUEUED' }]
    })
    expect(checks.success && checks.data).toMatchObject({
      details: { checks: [{ name: 'build', status: 'COMPLETED' }] }
    })
  })

  it('drops a file with no path, which no expansion or comment anchor could match', () => {
    const parsed = details({ files: [{ path: 'a.ts' }, { additions: 3 }] })
    expect(parsed.success && parsed.data).toMatchObject({ details: { files: [{ path: 'a.ts' }] } })
  })

  it('keeps an empty collection, which is what every recorded detail reply carries', () => {
    const parsed = details({ comments: [], checks: [], files: [], item: { reviewRequests: [] } })
    expect(parsed.success).toBe(true)
  })

  it('drops an assignable user with no login and keeps the rest of the row', () => {
    const parsed = taskProjectAssignableUserListSchema.safeParse({
      ok: true,
      users: [{ login: 'octocat', name: null, avatarUrl: null }, { name: 'nobody' }]
    })
    expect(parsed.success && parsed.data).toMatchObject({
      users: [{ login: 'octocat', name: null, avatarUrl: null }]
    })
  })
})
