import { describe, expect, it } from 'vitest'
import {
  gitHubReviewDetails,
  gitLabReviewDetails,
  hostedReviewSummary,
  REVIEW_HEAD,
  REVIEW_IDENTITY,
  reviewRuntime,
  reviewStatus,
  runReviewMethod
} from './mobile-web-review-test-fixture'

const diffParams = {
  ...REVIEW_IDENTITY,
  provider: 'github' as const,
  reviewNumber: 42,
  expectedReviewHead: REVIEW_HEAD,
  path: 'src/app.ts',
  offset: 0,
  limit: 1
}
const file = {
  path: 'src/app.ts',
  status: 'modified' as const,
  additions: 1,
  deletions: 1,
  isBinary: false,
  reviewCommentLineNumbers: [1]
}

describe('host-projected provider review diffs', () => {
  it('pages a pull-request file diff the provider answered with whole contents', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ files: [file] }),
      getRepoPRFileContents: {
        original: 'old\nshared',
        modified: 'new\nshared',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    })

    const first = (await runReviewMethod('mobileWeb.review.diff', diffParams, f.context)) as {
      rows: unknown[]
    }

    expect(first).toMatchObject({ kind: 'text', offset: 0, nextOffset: 1 })
    expect(first.rows).toHaveLength(1)
    expect(f.calls.at(-1)?.args[1]).toMatchObject({
      prNumber: 42,
      path: 'src/app.ts',
      headSha: REVIEW_HEAD,
      prRepo: { owner: 'acme', repo: 'orca' }
    })
  })

  it('refuses a later diff page whose revision no longer matches', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ files: [file] }),
      getRepoPRFileContents: {
        original: 'old',
        modified: 'new',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.diff',
        { ...diffParams, expectedRevision: '0'.repeat(64) },
        f.context
      )
    ).rejects.toThrow('conflict')
  })

  it('answers a binary review file without reading its contents', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ files: [{ ...file, isBinary: true }] })
    })

    await expect(
      runReviewMethod('mobileWeb.review.diff', diffParams, f.context)
    ).resolves.toMatchObject({ kind: 'binary' })
    expect(f.calls.map((call) => call.method)).not.toContain('getRepoPRFileContents')
  })

  it('pages a merge-request patch the provider already shipped inside the work item', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary({ provider: 'gitlab' }),
      getGitLabRepoWorkItemDetails: gitLabReviewDetails({
        files: [
          {
            path: 'src/app.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            isBinary: false,
            diff: '@@ -1 +1 @@\n-old\n+new\n'
          }
        ]
      })
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.diff',
        { ...diffParams, provider: 'gitlab', limit: 2 },
        f.context
      )
    ).resolves.toMatchObject({
      kind: 'text',
      rows: [
        { kind: 'delete', text: 'old' },
        { kind: 'add', text: 'new' }
      ]
    })
  })

  it('refuses a diff for a file the review does not list', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ files: [file] })
    })

    await expect(
      runReviewMethod('mobileWeb.review.diff', { ...diffParams, path: 'src/other.ts' }, f.context)
    ).rejects.toThrow('conflict')
  })

  it('reports a provider file the host refused to read as too large', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      getHostedReviewForBranch: hostedReviewSummary(),
      getRepoWorkItemDetails: gitHubReviewDetails({ files: [file] }),
      getRepoPRFileContents: {
        original: '',
        modified: '',
        originalIsBinary: false,
        modifiedIsBinary: false,
        modifiedTooLarge: true
      }
    })

    await expect(
      runReviewMethod('mobileWeb.review.diff', diffParams, f.context)
    ).resolves.toMatchObject({ kind: 'too-large', reason: 'host-limit' })
  })

  // Row text is capped at 1024 characters, but each one can escape to six JSON bytes.
  it.each([undefined, 96])(
    'clips escaped rows while retaining focus line %s',
    async (focusLine) => {
      const line = '\u0001'.repeat(1024)
      const f = reviewRuntime({
        getRuntimeGitStatus: reviewStatus(),
        getHostedReviewForBranch: hostedReviewSummary(),
        getRepoWorkItemDetails: gitHubReviewDetails({ files: [file] }),
        getRepoPRFileContents: {
          original: '',
          modified: Array.from({ length: 96 }, () => line).join('\n'),
          originalIsBinary: false,
          modifiedIsBinary: false
        }
      })

      const result = (await runReviewMethod(
        'mobileWeb.review.diff',
        { ...diffParams, limit: 96, focusLine },
        f.context
      )) as { rows: { newLineNumber?: number }[]; offset: number; nextOffset: number | null }

      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024)
      expect(result.rows.length).toBeLessThan(96)
      if (focusLine) {
        expect(result.rows.some((row) => row.newLineNumber === focusLine)).toBe(true)
        expect(result.offset).toBeGreaterThan(0)
        expect(result.nextOffset).toBeNull()
      } else {
        expect(result.nextOffset).toBe(result.rows.length)
      }
    }
  )
})
