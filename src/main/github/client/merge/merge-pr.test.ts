import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, getRestPRByNumberMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getRestPRByNumberMock: vi.fn()
}))

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))
vi.mock('../../repositories/github-api-repository', () => ({
  resolveGitHubRepoExecution: async () => ({
    ownerRepo: { owner: 'team', repo: 'orca' },
    ghOptions: {}
  })
}))
vi.mock('../lookup/pr-number-lookup', () => ({
  getRestPRByNumber: getRestPRByNumberMock,
  getPRByNumber: async () => null
}))
vi.mock('../../pull-requests/refresh/pr-mutation-review-invalidation', () => ({
  invalidateReviewLookupsAfterPRMutation: vi.fn()
}))

import { mergePR } from './merge-pr'

const REVIEWED_HEAD = '1111111111111111111111111111111111111111'
const PUSHED_HEAD = '2222222222222222222222222222222222222222'

describe('mergePR exact-head fence', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    getRestPRByNumberMock.mockReset()
  })

  it('refuses without merging when the PR head moved past the reviewed head', async () => {
    getRestPRByNumberMock.mockResolvedValue({ headRefOid: PUSHED_HEAD })

    const result = await mergePR('/repo', 7, 'squash', null, null, REVIEWED_HEAD)

    expect(result.ok).toBe(false)
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      REVIEWED_HEAD,
      ['pr', 'merge', '7', '--squash', '--repo', 'team/orca', '--match-head-commit', REVIEWED_HEAD]
    ],
    [null, ['pr', 'merge', '7', '--squash', '--repo', 'team/orca']]
  ])('merges with expected head %s', async (expectedHeadSha, argv) => {
    getRestPRByNumberMock.mockResolvedValue({ headRefOid: REVIEWED_HEAD })

    await expect(mergePR('/repo', 7, 'squash', null, null, expectedHeadSha)).resolves.toEqual({
      ok: true
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(argv, expect.anything())
  })
})
