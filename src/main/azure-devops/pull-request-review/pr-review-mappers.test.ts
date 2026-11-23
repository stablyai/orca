import { expect, it } from 'vitest'
import { azureDevOpsVoteLabel, mapChecks, mapThreads } from './pr-review-mappers'

it('keeps human discussion with its file and line, and drops system and deleted threads', () => {
  expect(
    mapThreads([
      {
        id: 1,
        status: 'active',
        comments: [{ id: 1, commentType: 'system', content: 'voted 10' }]
      },
      { id: 2, isDeleted: true, comments: [{ id: 1, commentType: 'text', content: 'gone' }] },
      {
        id: 3,
        status: 'fixed',
        threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 12 } },
        comments: [
          { id: 1, commentType: 'text', content: 'nit', author: { displayName: 'Ana' } },
          { id: 2, parentCommentId: 1, commentType: 'text', isDeleted: true, content: 'x' },
          { id: 3, parentCommentId: 1, commentType: 'text', content: 'done' }
        ]
      },
      {
        id: 4,
        status: 'unknown',
        threadContext: { filePath: '/b.ts', leftFileStart: { line: 4 } },
        comments: [{ id: 1, content: 'old side' }]
      }
    ])
  ).toEqual([
    {
      id: 3,
      status: 'fixed',
      filePath: '/src/a.ts',
      line: 12,
      comments: [
        { id: 1, parentId: null, author: 'Ana', publishedDate: null, content: 'nit' },
        { id: 3, parentId: 1, author: null, publishedDate: null, content: 'done' }
      ]
    },
    {
      id: 4,
      status: null,
      filePath: '/b.ts',
      line: 4,
      comments: [{ id: 1, parentId: null, author: null, publishedDate: null, content: 'old side' }]
    }
  ])
})

it('names policies, links builds and flags stale ones, and skips disabled policies', () => {
  expect(
    mapChecks(
      [
        {
          status: 'approved',
          configuration: {
            isBlocking: true,
            type: { displayName: 'Build' },
            settings: { displayName: 'ci' }
          },
          context: { buildId: 42, buildIsNotCurrent: true }
        },
        {
          status: 'queued',
          configuration: { isBlocking: false, type: { displayName: 'Required reviewers' } }
        },
        {
          status: 'approved',
          configuration: { isEnabled: false, type: { displayName: 'Comment requirements' } }
        }
      ],
      [
        {
          state: 'failed',
          context: { genre: 'scan', name: 'sast' },
          targetUrl: 'https://scan.example/1'
        }
      ],
      (buildId) => `https://ado.example/_build/results?buildId=${buildId}`
    )
  ).toEqual([
    {
      name: 'ci',
      kind: 'build',
      status: 'approved',
      isBlocking: true,
      buildId: 42,
      isStale: true,
      url: 'https://ado.example/_build/results?buildId=42'
    },
    {
      name: 'Required reviewers',
      kind: 'policy',
      status: 'queued',
      isBlocking: false,
      buildId: null,
      isStale: false,
      url: null
    },
    {
      name: 'scan/sast',
      kind: 'status',
      status: 'failed',
      isBlocking: false,
      buildId: null,
      isStale: false,
      url: 'https://scan.example/1'
    }
  ])
  expect([10, 5, 0, -5, -10, 7, null].map(azureDevOpsVoteLabel)).toEqual([
    'approved',
    'approved-with-suggestions',
    'no-vote',
    'waiting-for-author',
    'rejected',
    'no-vote',
    'no-vote'
  ])
})
