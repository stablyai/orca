import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../src/shared/types'
import {
  buildAddRootCommentParams,
  buildDeleteCommentParams,
  buildEditCommentParams,
  buildReplyParams,
  buildResolveParams,
  canAddRootComment,
  canDeleteComment,
  canEditComment,
  isMutablePRConversationComment,
  isResolvableComment,
  isSubmittableCommentBody
} from './pr-comment-actions'

function comment(over: Partial<PRComment> = {}): PRComment {
  return {
    id: 42,
    author: 'octocat',
    authorAvatarUrl: '',
    body: 'hi',
    createdAt: 'now',
    url: 'u',
    ...over
  }
}

describe('isResolvableComment', () => {
  it('is true only for thread-bearing comments', () => {
    expect(isResolvableComment(comment({ threadId: 'T_1' }))).toBe(true)
    expect(isResolvableComment(comment())).toBe(false)
    expect(isResolvableComment(comment({ threadId: '' }))).toBe(false)
  })
})

describe('canAddRootComment', () => {
  it('allows root comments only on open/draft PRs', () => {
    expect(canAddRootComment('open')).toBe(true)
    expect(canAddRootComment('draft')).toBe(true)
    expect(canAddRootComment('closed')).toBe(false)
    expect(canAddRootComment('merged')).toBe(false)
    expect(canAddRootComment(null)).toBe(false)
  })
})

describe('buildReplyParams', () => {
  it('carries commentId + body and forwards thread context when present', () => {
    const params = buildReplyParams(7, comment({ threadId: 'T_1', path: 'a.ts', line: 9 }), 'reply')
    expect(params).toEqual({
      prNumber: 7,
      commentId: 42,
      body: 'reply',
      threadId: 'T_1',
      path: 'a.ts',
      line: 9
    })
  })

  it('omits optional thread context for plain comments', () => {
    const params = buildReplyParams(7, comment(), 'reply')
    expect(params).toEqual({ prNumber: 7, commentId: 42, body: 'reply' })
    expect('threadId' in params).toBe(false)
    expect('path' in params).toBe(false)
    expect('line' in params).toBe(false)
  })
})

describe('buildResolveParams', () => {
  it('toggles to resolve when currently unresolved', () => {
    expect(buildResolveParams(comment({ threadId: 'T_1' }))).toEqual({
      threadId: 'T_1',
      resolve: true
    })
  })

  it('toggles to unresolve when currently resolved', () => {
    expect(buildResolveParams(comment({ threadId: 'T_1', isResolved: true }))).toEqual({
      threadId: 'T_1',
      resolve: false
    })
  })

  it('returns null when there is no thread', () => {
    expect(buildResolveParams(comment())).toBeNull()
  })
})

describe('buildAddRootCommentParams', () => {
  it('builds number + body', () => {
    expect(buildAddRootCommentParams(7, 'hello')).toEqual({ prNumber: 7, body: 'hello' })
  })
})

describe('isSubmittableCommentBody', () => {
  it('rejects blank/whitespace bodies', () => {
    expect(isSubmittableCommentBody('hi')).toBe(true)
    expect(isSubmittableCommentBody('')).toBe(false)
    expect(isSubmittableCommentBody('   \n ')).toBe(false)
  })
})

describe('isMutablePRConversationComment', () => {
  it('allows only root conversation comments with a valid id', () => {
    expect(isMutablePRConversationComment(comment())).toBe(true)
  })

  it('excludes review/threaded/inline comments', () => {
    expect(isMutablePRConversationComment(comment({ threadId: 'T_1' }))).toBe(false)
    expect(isMutablePRConversationComment(comment({ path: 'a.ts' }))).toBe(false)
    expect(
      isMutablePRConversationComment(comment({ url: 'https://x/pullrequestreview-1#r2' }))
    ).toBe(false)
  })

  it('requires a positive integer id', () => {
    expect(isMutablePRConversationComment(comment({ id: 0 }))).toBe(false)
    expect(isMutablePRConversationComment(comment({ id: -1 }))).toBe(false)
  })
})

describe('canEditComment / canDeleteComment', () => {
  const slug = { owner: 'o', repo: 'r' }

  it('require both a repo slug and a mutable comment', () => {
    expect(canEditComment(comment(), slug)).toBe(true)
    expect(canDeleteComment(comment(), slug)).toBe(true)
    expect(canEditComment(comment(), null)).toBe(false)
    expect(canDeleteComment(comment(), undefined)).toBe(false)
    expect(canEditComment(comment({ threadId: 'T_1' }), slug)).toBe(false)
    expect(canDeleteComment(comment({ path: 'a.ts' }), slug)).toBe(false)
  })
})

describe('buildEditCommentParams / buildDeleteCommentParams', () => {
  it('build slug-addressed params', () => {
    const slug = { owner: 'o', repo: 'r' }
    expect(buildEditCommentParams(slug, 42, 'new body')).toEqual({
      owner: 'o',
      repo: 'r',
      commentId: 42,
      body: 'new body'
    })
    expect(buildDeleteCommentParams(slug, 42)).toEqual({ owner: 'o', repo: 'r', commentId: 42 })
  })
})
