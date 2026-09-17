import { describe, expect, it } from 'vitest'
import {
  taskProjectAccessibleListSchema,
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
    for (const ownerType of ['organization', 'user'] as const) {
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
        { owner: 'a', ownerType: 'organization', number: 1 },
        { owner: 'b', ownerType: 'enterprise', number: 2 }
      ]
    })
    expect(parsed.success && parsed.data).toMatchObject({
      projects: [{ owner: 'a', ownerType: 'organization', number: 1 }]
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
