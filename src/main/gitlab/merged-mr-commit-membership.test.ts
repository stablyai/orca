import { beforeEach, expect, it, vi } from 'vitest'
import type * as GlabApiResponse from './glab-api-response'
const { pages, viewer } = vi.hoisted(() => ({ pages: vi.fn(), viewer: vi.fn() }))
vi.mock('./gl-utils', async () => ({
  ...(await vi.importActual<typeof GlabApiResponse>('./glab-api-response')),
  glabApiWithHeaders: pages,
  glabHostnameArgs: () => [],
  glabRepoExecOptions: () => ({ cwd: '/repo' })
}))
vi.mock('./gitlab-auth-and-rate-limit', () => ({ readGlabViewer: viewer }))
import {
  mergedMRContainsHead,
  resetMergedMRCommitMembershipForTest
} from './merged-mr-commit-membership'
const args = {
  repoPath: '/repo',
  project: { host: 'gitlab.com', path: 'g/p' },
  targetProjectId: 1,
  iid: 7,
  headOid: 'f'.repeat(40),
  revisionHeadSha: 'a'.repeat(40),
  localGitOptions: {}
}
beforeEach(() => {
  resetMergedMRCommitMembershipForTest()
  pages.mockReset()
  viewer.mockReset().mockResolvedValue({ id: 1 })
})
it.each([10, 100])(
  'reuses a complete 500-commit result across %s admitted refreshes and coalesces a cold walk',
  async (count) => {
    pages.mockImplementation(async ([endpoint]: string[]) => {
      const page = Number(new URL(endpoint, 'https://gitlab.com').searchParams.get('page'))
      return {
        body: JSON.stringify(
          Array.from({ length: 100 }, (_, i) => ({
            id:
              page === 5 && i === 99
                ? args.headOid
                : (page * 100 + i).toString(16).padStart(40, '0')
          }))
        ),
        headers: { 'x-next-page': page < 5 ? String(page + 1) : '' }
      }
    })
    await expect(
      Promise.all([mergedMRContainsHead(args), mergedMRContainsHead(args)])
    ).resolves.toEqual(['contained', 'contained'])
    for (let i = 0; i < count; i++) {
      await expect(mergedMRContainsHead(args)).resolves.toBe('contained')
    }
    expect(pages).toHaveBeenCalledTimes(5)
    viewer.mockResolvedValue({ id: 2 })
    await mergedMRContainsHead(args)
    expect(pages).toHaveBeenCalledTimes(10)
  }
)
it('preserves a failed page as unavailable, and a user refresh retries it', async () => {
  pages
    .mockResolvedValueOnce({
      body: JSON.stringify(
        Array.from({ length: 100 }, (_, i) => ({ id: i.toString(16).padStart(40, '0') }))
      ),
      headers: { 'x-next-page': '2' }
    })
    .mockRejectedValueOnce(new Error('offline'))
  await expect(mergedMRContainsHead(args)).rejects.toThrow()
  await expect(mergedMRContainsHead(args)).rejects.toThrow()
  expect(pages).toHaveBeenCalledTimes(2)
  pages.mockResolvedValue({
    body: JSON.stringify([{ id: args.headOid }]),
    headers: { 'x-next-page': '' }
  })
  await expect(mergedMRContainsHead({ ...args, userRefresh: true })).resolves.toBe('contained')
  expect(pages).toHaveBeenCalledTimes(3)
})
it('does a fresh authorized walk without a usable viewer identity', async () => {
  viewer.mockRejectedValue(new Error('no viewer'))
  pages.mockResolvedValue({ body: '[]', headers: { 'x-next-page': '' } })
  await expect(mergedMRContainsHead(args)).resolves.toBe('not-contained')
  await expect(mergedMRContainsHead(args)).resolves.toBe('not-contained')
  expect(pages).toHaveBeenCalledTimes(2)
})
