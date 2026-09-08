import { beforeEach, describe, expect, it, vi } from 'vitest'
import { submitHostedReview } from './hosted-review-submission'

const { addMRCommentMock, addMRInlineCommentMock, submitGitHubPullRequestReviewMock } = vi.hoisted(
  () => ({
    addMRCommentMock: vi.fn(),
    addMRInlineCommentMock: vi.fn(),
    submitGitHubPullRequestReviewMock: vi.fn()
  })
)

vi.mock('../github/pr-review-submission', () => ({
  submitGitHubPullRequestReview: submitGitHubPullRequestReviewMock
}))

vi.mock('../gitlab/client', () => ({
  addMRComment: addMRCommentMock,
  addMRInlineComment: addMRInlineCommentMock
}))

describe('hosted review submission', () => {
  beforeEach(() => {
    addMRCommentMock.mockReset()
    addMRInlineCommentMock.mockReset()
    submitGitHubPullRequestReviewMock.mockReset()
    addMRInlineCommentMock.mockResolvedValue({ ok: true, comment: {} })
    addMRCommentMock.mockResolvedValue({ ok: true, comment: {} })
  })

  it('submits GitLab discussions in order with native-only project and diff refs', async () => {
    await expect(
      submitHostedReview(
        '/repo',
        {
          provider: 'gitlab',
          number: 17,
          expectedHead: 'c'.repeat(40),
          action: 'comment',
          summary: 'Summary',
          comments: [
            {
              path: 'src/review.ts',
              oldPath: 'src/old-review.ts',
              line: 12,
              body: 'Queued'
            }
          ],
          projectRef: { host: 'gitlab.example.com', path: 'acme/widgets' },
          baseSha: 'a'.repeat(40),
          startSha: 'b'.repeat(40)
        },
        'upstream',
        'ssh-1',
        { localGitExecOptions: { wslDistro: 'Ubuntu' } }
      )
    ).resolves.toEqual({ ok: true, action: 'comment', submittedComments: 1 })

    expect(addMRInlineCommentMock).toHaveBeenCalledWith(
      '/repo',
      17,
      {
        body: 'Queued',
        path: 'src/review.ts',
        oldPath: 'src/old-review.ts',
        line: 12,
        baseSha: 'a'.repeat(40),
        startSha: 'b'.repeat(40),
        headSha: 'c'.repeat(40)
      },
      'upstream',
      'ssh-1',
      { host: 'gitlab.example.com', path: 'acme/widgets' },
      { wslDistro: 'Ubuntu' }
    )
    expect(addMRCommentMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      addMRInlineCommentMock.mock.invocationCallOrder[0]!
    )
  })

  it('reports partial GitLab delivery without replaying later comments or the summary', async () => {
    addMRInlineCommentMock
      .mockResolvedValueOnce({ ok: true, comment: {} })
      .mockResolvedValueOnce({ ok: false, error: 'provider unavailable' })
    const result = await submitHostedReview('/repo', {
      provider: 'gitlab',
      number: 17,
      expectedHead: 'c'.repeat(40),
      action: 'comment',
      summary: 'Summary',
      comments: [
        { path: 'one.ts', line: 1, body: 'One' },
        { path: 'two.ts', line: 2, body: 'Two' },
        { path: 'three.ts', line: 3, body: 'Three' }
      ],
      projectRef: { host: 'gitlab.com', path: 'acme/widgets' },
      baseSha: 'a'.repeat(40),
      startSha: 'b'.repeat(40)
    })
    expect(result).toMatchObject({ ok: false, code: 'partial', submittedComments: 1 })
    expect(addMRInlineCommentMock).toHaveBeenCalledTimes(2)
    expect(addMRCommentMock).not.toHaveBeenCalled()
  })
})
