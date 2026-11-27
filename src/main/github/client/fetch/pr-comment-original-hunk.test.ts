import { expect, it } from 'vitest'
import { threadDiffLines } from '../../../../shared/github/comments/pr-comment-diff-hunk'
import { parsePRConversationResponse } from './pr-conversation-response'

it('maps original-side review context without relabeling moved coordinates', () => {
  const response = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'left-thread',
                isResolved: false,
                line: 42,
                startLine: 40,
                originalLine: 42,
                originalStartLine: 40,
                diffSide: 'LEFT',
                startDiffSide: 'LEFT',
                rootHunk: {
                  nodes: [
                    {
                      diffHunk: '@@ -40,3 +40,3 @@\n-old first\n+new first\n context\n-old last'
                    }
                  ]
                },
                comments: {
                  nodes: [
                    {
                      id: 'review-comment',
                      databaseId: 7,
                      author: { login: 'reviewer', avatarUrl: '' },
                      body: 'Why remove these lines?',
                      createdAt: '2026-01-01T00:00:00Z',
                      url: 'https://github.com/example/repo/pull/1#discussion_r7',
                      path: 'example.ts'
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    }
  })

  const [root] = parsePRConversationResponse(response).reviewComments
  expect(root.originalDiffHunk).toBe('-old first\n+new first\n context\n-old last')
  // Keep old-side context separate from the existing new-side field.
  expect(root.diffHunk).toBeUndefined()
  expect(threadDiffLines(root.originalDiffHunk!, root.line!, root.startLine, 'LEFT')).toEqual([
    { index: 0, number: 40, sign: '-', text: 'old first' },
    { index: 1, number: null, sign: '+', text: 'new first' },
    { index: 2, number: 41, sign: ' ', text: 'context' },
    { index: 3, number: 42, sign: '-', text: 'old last' }
  ])
  expect(threadDiffLines(' context\n-old line\n+new line', 41, 40)).toEqual([
    { index: 0, number: 40, sign: ' ', text: 'context' },
    { index: 1, number: null, sign: '-', text: 'old line' },
    { index: 2, number: 41, sign: '+', text: 'new line' }
  ])
  const crossSide = parsePRConversationResponse(
    response.replace('"startDiffSide":"LEFT"', '"startDiffSide":"RIGHT"')
  ).reviewComments[0]
  expect(crossSide.originalDiffHunk).toBeUndefined()
  const movedEnd = parsePRConversationResponse(response.replace('"line":42', '"line":142'))
    .reviewComments[0]
  expect(movedEnd.originalDiffHunk).toBeUndefined()
  const movedStart = parsePRConversationResponse(
    response.replace('"startLine":40', '"startLine":41')
  ).reviewComments[0]
  expect(movedStart.originalDiffHunk).toBeUndefined()
})
