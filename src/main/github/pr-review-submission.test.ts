import { beforeEach, describe, expect, it, vi } from 'vitest'
import { submitGitHubPullRequestReview } from './pr-review-submission'

const { ghExecFileAsyncMock, resolveGitHubRepoExecutionMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  resolveGitHubRepoExecutionMock: vi.fn()
}))

vi.mock('./github-api-repository', () => ({
  resolveGitHubRepoExecution: resolveGitHubRepoExecutionMock
}))

vi.mock('./gh-utils', () => ({
  acquire: vi.fn(),
  classifyGhError: (value: string) => ({ message: value }),
  ghExecFileAsync: ghExecFileAsyncMock,
  release: vi.fn()
}))

describe('GitHub pull request review submission', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    resolveGitHubRepoExecutionMock.mockReset()
    resolveGitHubRepoExecutionMock.mockResolvedValue({
      ownerRepo: { host: 'github.example.com', owner: 'acme', repo: 'widgets' },
      ghOptions: { host: 'github.example.com', wslDistro: 'Ubuntu' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '{"id":91}', stderr: '' })
  })

  it('sends one atomic JSON review with the exact head, verdict, and line ranges', async () => {
    await expect(
      submitGitHubPullRequestReview({
        repoPath: '/repo',
        repository: { host: 'github.example.com', owner: 'acme', repo: 'widgets' },
        number: 17,
        expectedHead: 'a'.repeat(40),
        action: 'request-changes',
        summary: 'Please address this.',
        comments: [{ path: 'src/review.ts', startLine: 10, line: 12, body: 'Keep the range.' }],
        localGitOptions: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toEqual({ ok: true, action: 'request-changes', submittedComments: 1 })

    const [argv, options] = ghExecFileAsyncMock.mock.calls[0]!
    expect(argv).toEqual([
      'api',
      '-X',
      'POST',
      'repos/acme/widgets/pulls/17/reviews',
      '--input',
      '-'
    ])
    expect(options).toMatchObject({
      host: 'github.example.com',
      wslDistro: 'Ubuntu',
      idempotent: false
    })
    expect(JSON.parse(options.stdin)).toEqual({
      commit_id: 'a'.repeat(40),
      event: 'REQUEST_CHANGES',
      body: 'Please address this.',
      comments: [
        {
          path: 'src/review.ts',
          start_line: 10,
          line: 12,
          start_side: 'RIGHT',
          side: 'RIGHT',
          body: 'Keep the range.'
        }
      ]
    })
    expect(argv.join(' ')).not.toContain('Please address this.')
  })

  it('rejects malformed provider success responses', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{"state":"APPROVED"}', stderr: '' })
    await expect(
      submitGitHubPullRequestReview({
        repoPath: '/repo',
        repository: { owner: 'acme', repo: 'widgets' },
        number: 17,
        expectedHead: 'a'.repeat(40),
        action: 'approve',
        summary: '',
        comments: []
      })
    ).resolves.toMatchObject({ ok: false, code: 'provider_error' })
  })
})
