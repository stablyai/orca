import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('./gh-utils', () => ({
  ghExecFileAsync: mocks.exec,
  acquire: async () => {},
  release: () => {},
  classifyGhError: () => ({ type: 'unknown' })
}))
vi.mock('./github-api-repository', () => ({
  resolveGitHubRepoExecution: async () => ({
    ownerRepo: { owner: 'acme', repo: 'widgets' },
    ghOptions: {}
  })
}))
import { addIssueComment } from './issue-comment'
import { addPRReviewComment, addPRReviewCommentReply } from './client/create/add-pr-review-comment'

it('returns signed display sources immediately after posting the original Markdown', async () => {
  const body =
    '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify({
      id: 1,
      user: null,
      body,
      body_html:
        '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
    })
  })
  const result = await addIssueComment('/repo', 42, body)
  expect(mocks.exec.mock.calls[0][0]).toContain('Accept: application/vnd.github.full+json')
  expect(mocks.exec.mock.calls[0][1].stdin).toBe(JSON.stringify({ body }))
  expect(result.ok && result.comment.body).toBe(body)
  expect(result.ok && result.comment.bodyImageUrls).toEqual({
    'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
      'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
  })
})

it.each(['review', 'reply'])(
  'returns paired image sources immediately for %s posts',
  async (kind) => {
    mocks.exec.mockClear()
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    mocks.exec.mockResolvedValue({
      stdout: JSON.stringify({
        id: 1,
        body,
        user: null,
        body_html:
          '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
      })
    })
    const result =
      kind === 'review'
        ? await addPRReviewComment({
            repoPath: '/repo',
            prNumber: 7,
            body,
            commitId: 'head',
            path: 'file.ts',
            line: 1
          })
        : await addPRReviewCommentReply('/repo', 7, 1, body)
    expect(result.ok && result.comment.bodyImageUrls).toEqual({
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
        'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    })
    expect(mocks.exec.mock.calls[0][0]).toContain(
      'body=![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    )
  }
)
