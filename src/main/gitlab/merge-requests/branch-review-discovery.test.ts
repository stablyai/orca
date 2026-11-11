import { beforeEach, expect, it, vi } from 'vitest'

const { read, pages } = vi.hoisted(() => ({ read: vi.fn(), pages: vi.fn() }))
vi.mock('../../git/command-runner/glab-exec-file', () => ({
  glabExecFileAsync: read
}))

vi.mock('../requests/glab-request-admission', () => ({
  glabApiWithHeaders: pages
}))

vi.mock('../projects/gitlab-project-ref-resolution', () => ({
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
