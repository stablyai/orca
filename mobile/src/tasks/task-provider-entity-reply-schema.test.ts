import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  assignableUserListSchema,
  detailCheckListSchema,
  detailCommentListSchema,
  detailFileListSchema,
  reviewSummaryListSchema,
  taskCommentWriteEnvelopeSchema,
  taskMutationEnvelopeSchema
} from './task-provider-entity-reply-schema'

// The entity claims the four tasks schema modules are built on: which member a row is identified
// by, which arm sets are closed, and which members keep an explicit null.

function reads<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`expected a readable reply: ${parsed.error.message}`)
  }
  return parsed.data
}

function refuses(schema: z.ZodType<unknown, unknown>, value: unknown): boolean {
  return !schema.safeParse(value).success
}

const COMMENT = { id: 902, author: 'You', body: 'a comment', createdAt: '2020-01-01T00:00:00.000Z' }

describe('the mutation envelope', () => {
  it('keeps ok tri-state, so absent is the success main read and false is a refusal', () => {
    expect(reads(taskMutationEnvelopeSchema, {}).ok).toBeUndefined()
    expect(reads(taskMutationEnvelopeSchema, { ok: true }).ok).toBe(true)
    expect(reads(taskMutationEnvelopeSchema, { ok: false }).ok).toBe(false)
  })

  it('reads a non-boolean ok as absent, which is the success main read for it', () => {
    expect(reads(taskMutationEnvelopeSchema, { ok: 'false' }).ok).toBeUndefined()
  })

  it('requires the container, which is the property read main died on', () => {
    expect(refuses(taskMutationEnvelopeSchema, null)).toBe(true)
    expect(refuses(taskMutationEnvelopeSchema, 'accepted')).toBe(true)
    expect(refuses(taskMutationEnvelopeSchema, 7)).toBe(true)
  })

  it('drops an error that is not text, so the call site shows its own copy', () => {
    expect(reads(taskMutationEnvelopeSchema, { ok: false, error: 'boom' }).error).toBe('boom')
    expect(
      reads(taskMutationEnvelopeSchema, { ok: false, error: { message: 'boom' } }).error
    ).toBeUndefined()
  })

  it('passes members it does not declare straight through', () => {
    expect(reads(taskMutationEnvelopeSchema, { ok: true, number: 11 })).toMatchObject({
      number: 11
    })
  })
})

describe('a comment row', () => {
  it('requires the id it is keyed by and the body it renders', () => {
    expect(reads(detailCommentListSchema, [COMMENT])).toHaveLength(1)
    expect(reads(detailCommentListSchema, [{ ...COMMENT, id: 'c-1' }])[0]?.id).toBe('c-1')
    expect(reads(detailCommentListSchema, [{ ...COMMENT, id: undefined }])).toEqual([])
    expect(reads(detailCommentListSchema, [{ ...COMMENT, body: undefined }])).toEqual([])
  })

  it('drops the unreadable row rather than the whole list', () => {
    expect(reads(detailCommentListSchema, [COMMENT, { id: 1 }])).toHaveLength(1)
  })

  it('refuses a list that is not one', () => {
    expect(refuses(detailCommentListSchema, { comments: [] })).toBe(true)
    expect(refuses(detailCommentListSchema, 'none')).toBe(true)
  })

  it('forwards every provider reaction, including the two vocabularies mobile never declared', () => {
    const github = [
      { content: '+1', count: 3 },
      { content: '-1', count: 1 },
      { content: 'heart', count: 1 }
    ]
    expect(
      reads(detailCommentListSchema, [{ ...COMMENT, reactions: github }])[0]?.reactions
    ).toEqual(github)
    const gitlab = [{ name: 'thumbsup', count: 2 }]
    expect(
      reads(detailCommentListSchema, [{ ...COMMENT, reactions: gitlab }])[0]?.reactions
    ).toMatchObject([{ count: 2 }])
  })

  it('keeps the count the chip filters on and lets a malformed content read as absent', () => {
    const row = reads(detailCommentListSchema, [
      { ...COMMENT, reactions: [{ content: 7, count: 2 }] }
    ])[0]
    expect(row?.reactions).toEqual([{ count: 2 }])
    expect(
      reads(detailCommentListSchema, [{ ...COMMENT, reactions: [{ content: '+1' }] }])[0]?.reactions
    ).toEqual([])
  })

  it('leaves every guarded member exactly as the host sent it', () => {
    const row = reads(detailCommentListSchema, [
      { ...COMMENT, path: 'src/a.ts', line: 12, threadId: 't-1', isResolved: false }
    ])[0]
    expect(row).toMatchObject({ path: 'src/a.ts', line: 12, threadId: 't-1', isResolved: false })
  })
})

describe('the comment write envelope', () => {
  it('drops a comment the timeline could not key, leaving the local echo in place', () => {
    expect(
      reads(taskCommentWriteEnvelopeSchema, { ok: true, comment: COMMENT }).comment
    ).toMatchObject({ id: 902 })
    expect(
      reads(taskCommentWriteEnvelopeSchema, { ok: true, comment: { id: 902 } }).comment
    ).toBeUndefined()
    expect(reads(taskCommentWriteEnvelopeSchema, { ok: true }).comment).toBeUndefined()
  })
})

describe('a user row', () => {
  it('requires the login every reader trims, and keeps an explicit null beside it', () => {
    const rows = reads(assignableUserListSchema, [
      { login: 'octocat', name: 'Octo', avatarUrl: null }
    ])
    expect(rows[0]).toMatchObject({ login: 'octocat', name: 'Octo', avatarUrl: null })
    expect(reads(assignableUserListSchema, [{ name: 'Octo' }])).toEqual([])
  })

  it('keeps a review row own null state rather than defaulting it', () => {
    expect(reads(reviewSummaryListSchema, [{ login: 'octocat', state: null }])[0]?.state).toBeNull()
    expect(reads(reviewSummaryListSchema, [{ state: 'APPROVED' }])).toEqual([])
  })
})

describe('a check row and a file row', () => {
  it('keeps the host casing the tasks surface actually sends', () => {
    const checks = reads(detailCheckListSchema, [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', url: '' }
    ])
    expect(checks[0]).toMatchObject({ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' })
  })

  it('drops a check with no name or no status', () => {
    expect(reads(detailCheckListSchema, [{ status: 'completed' }])).toEqual([])
    expect(reads(detailCheckListSchema, [{ name: 'build' }])).toEqual([])
  })

  it('requires the path a file row is matched by', () => {
    expect(reads(detailFileListSchema, [{ path: 'src/a.ts' }])).toHaveLength(1)
    expect(reads(detailFileListSchema, [{ oldPath: 'src/a.ts' }])).toEqual([])
  })

  it('carries every file status the host will accept back and drops one it would refuse', () => {
    for (const status of [
      'added',
      'modified',
      'removed',
      'renamed',
      'copied',
      'changed',
      'unchanged'
    ]) {
      expect(reads(detailFileListSchema, [{ path: 'a', status }])[0]?.status).toBe(status)
    }
    // Absent is what the call site turns into `'modified'`; the host's own params enum would
    // refuse the arm itself.
    expect(reads(detailFileListSchema, [{ path: 'a', status: 'ADDED' }])[0]?.status).toBeUndefined()
  })

  it('forwards a viewed state the host has and one this build predates', () => {
    for (const viewerViewedState of ['DISMISSED', 'VIEWED', 'UNVIEWED', 'PENDING']) {
      expect(
        reads(detailFileListSchema, [{ path: 'a', viewerViewedState }])[0]?.viewerViewedState
      ).toBe(viewerViewedState)
    }
  })

  it('salvages a malformed viewed state to absent and keeps the row', () => {
    const row = reads(detailFileListSchema, [{ path: 'a', viewerViewedState: { v: 'VIEWED' } }])[0]
    expect(row?.path).toBe('a')
    expect(row?.viewerViewedState).toBeUndefined()
  })
})
