import { beforeEach, expect, it, vi } from 'vitest'
import type * as GlabApiResponse from './glab-api-response'
const { read, pages } = vi.hoisted(() => ({ read: vi.fn(), pages: vi.fn() }))
vi.mock('./gl-utils', async () => ({
  ...(await vi.importActual<typeof GlabApiResponse>('./glab-api-response')),
  glabExecFileAsync: read,
  glabApiWithHeaders: pages,
  glabHostnameArgs: () => [],
  glabRepoExecOptions: () => ({})
}))
import { createGitLabBranchDiscovery } from './branch-review-discovery'
const args = {
  repoPath: '/repo',
  project: { host: 'gitlab.com', path: 'g/p' },
  sourceProjectId: 1,
  localGitOptions: {}
}
const row = (iid: number, state = 'merged', source = 1) => ({
  iid,
  state,
  source_project_id: source,
  target_project_id: 2,
  source_branch: 'feature',
  updated_at: `2026-11-01T00:00:${String(iid % 60).padStart(2, '0')}Z`
})
beforeEach(() => {
  read.mockReset()
  pages.mockReset()
})
it('prefers an older active MR and probes both active states behind a full recent page', async () => {
  read
    .mockResolvedValueOnce({
      stdout: JSON.stringify(Array.from({ length: 10 }, (_, i) => row(i + 1)))
    })
    .mockResolvedValueOnce({ stdout: JSON.stringify([row(11, 'opened')]) })
    .mockResolvedValueOnce({ stdout: JSON.stringify([row(12, 'locked')]) })
  await expect(createGitLabBranchDiscovery(args)('feature')).resolves.toMatchObject({ iid: 12 })
  expect(read.mock.calls.map(([a]) => a.at(-1))).toEqual([
    expect.stringContaining('source_project_id=1&state=all&per_page=10'),
    expect.stringContaining('source_project_id=1&state=opened&per_page=1'),
    expect.stringContaining('source_project_id=1&state=locked&per_page=1')
  ])
})
it.each(['foreign', 'locked'])(
  'completes the existing branch-filtered endpoint on legacy %s filtering',
  async (mode) => {
    read.mockResolvedValueOnce({
      stdout: JSON.stringify(
        mode === 'foreign'
          ? [row(1, 'opened', 8)]
          : Array.from({ length: 10 }, (_, i) => row(i + 1))
      )
    })
    if (mode === 'locked') {
      read
        .mockResolvedValueOnce({ stdout: '[]' })
        .mockRejectedValueOnce({ stderr: 'HTTP 400: state does not have a valid value: locked' })
    }
    pages.mockImplementation(async ([endpoint]: string[]) => ({
      body: JSON.stringify(
        new URL(endpoint, 'https://gitlab.com').searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, (_, i) => row(i + 1, 'opened', 8))
          : [row(101, 'opened')]
      ),
      headers: {
        'x-next-page':
          new URL(endpoint, 'https://gitlab.com').searchParams.get('page') === '1' ? '2' : ''
      }
    }))
    await expect(createGitLabBranchDiscovery(args)('feature')).resolves.toMatchObject({ iid: 101 })
    expect(pages.mock.calls[0][0][0]).toContain('&state=all&per_page=100&page=1')
    expect(pages.mock.calls[0][0][0]).not.toContain('source_project_id=')
  }
)
it('does not turn an active-probe failure into historical absence', async () => {
  read
    .mockResolvedValueOnce({
      stdout: JSON.stringify(Array.from({ length: 10 }, (_, i) => row(i + 1)))
    })
    .mockRejectedValueOnce(new Error('offline'))
  await expect(createGitLabBranchDiscovery(args)('feature')).rejects.toThrow('offline')
  expect(pages).not.toHaveBeenCalled()
})
it('fails a legacy traversal rather than selecting from an incomplete foreign prefix', async () => {
  read.mockResolvedValue({ stdout: JSON.stringify([row(1, 'opened', 8)]) })
  pages
    .mockResolvedValueOnce({
      body: JSON.stringify(Array.from({ length: 100 }, (_, i) => row(i + 1, 'opened', 8))),
      headers: { 'x-next-page': '2' }
    })
    .mockRejectedValueOnce(new Error('offline'))
  await expect(createGitLabBranchDiscovery(args)('feature')).rejects.toThrow('incomplete')
})

it.each([1000])(
  'walks %s raw legacy rows once before choosing an eligible source',
  async (count) => {
    read.mockResolvedValue({ stdout: JSON.stringify([row(1, 'opened', 8)]) })
    pages.mockImplementation(async ([endpoint]: string[]) => {
      const query = new URL(endpoint, 'https://gitlab.com').searchParams
      const page = Number(query.get('page'))
      const branch = query.get('source_branch')
      return {
        body: JSON.stringify(
          Array.from({ length: 100 }, (_, i) => {
            const iid = (page - 1) * 100 + i + 1
            return {
              ...row(iid, 'opened', iid === count && branch === 'renamed' ? 1 : 8),
              source_branch: branch
            }
          })
        ),
        headers: { 'x-next-page': page * 100 < count ? String(page + 1) : '' }
      }
    })
    const discover = createGitLabBranchDiscovery(args)
    await expect(discover('feature')).resolves.toBeNull()
    await expect(discover('renamed')).resolves.toMatchObject({
      iid: count,
      source_branch: 'renamed'
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(pages).toHaveBeenCalledTimes((2 * count) / 100)
  }
)
