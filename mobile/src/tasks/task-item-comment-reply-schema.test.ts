import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  linearCommentWrittenSchema,
  reviewThreadResolvedSchema,
  taskCommentWrittenSchema
} from './task-item-comment-reply-schema'

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

describe('the five writes that answer with a comment', () => {
  it('reads the recorded GitHub, GitLab and review-reply envelopes unchanged', () => {
    for (const comment of [
      { id: 902, author: 'You', body: 'a comment', createdAt: '2020-01-01T00:00:00.000Z' },
      {
        id: 903,
        author: 'You',
        body: 'a reply',
        createdAt: '2020-01-01T00:00:00.000Z',
        path: 'src/index.ts',
        line: 12,
        threadId: 'thread-1'
      }
    ]) {
      expect(reads(taskCommentWrittenSchema, { ok: true, comment }).comment).toMatchObject(comment)
    }
  })

  it('keeps ok tri-state and leaves the refusal wording to the call site', () => {
    expect(reads(taskCommentWrittenSchema, { ok: false }).error).toBeUndefined()
    expect(reads(taskCommentWrittenSchema, { ok: false, error: 'no' }).error).toBe('no')
    expect(reads(taskCommentWrittenSchema, {}).ok).toBeUndefined()
  })

  it('names a reply that is not the envelope, which main read members off', () => {
    expect(refuses(taskCommentWrittenSchema, null)).toBe(true)
    expect(refuses(taskCommentWrittenSchema, 'posted')).toBe(true)
  })
})

describe('the Linear comment write', () => {
  it('reads the recorded reply and leaves a missing id to the local echo', () => {
    expect(reads(linearCommentWrittenSchema, { ok: true, id: 'comment-9' }).id).toBe('comment-9')
    expect(reads(linearCommentWrittenSchema, { ok: true }).id).toBeUndefined()
    expect(refuses(linearCommentWrittenSchema, null)).toBe(true)
  })
})

describe('resolving a review thread', () => {
  it('keeps a real false, and names a reply that is not a boolean', () => {
    expect(reads(reviewThreadResolvedSchema, true)).toBe(true)
    expect(reads(reviewThreadResolvedSchema, false)).toBe(false)
    expect(refuses(reviewThreadResolvedSchema, 'true')).toBe(true)
    expect(refuses(reviewThreadResolvedSchema, undefined)).toBe(true)
  })
})
