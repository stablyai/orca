import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../../shared/testing/remove-temp-dirs.test-support'
import {
  createLinkedWorktreeFixture,
  FORK_URL,
  ORIGIN_URL,
  restoreGitConfigEnv,
  type LinkedWorktreeFixture
} from '../../github/client/lookup/tracked-upstream-worktrees.test-support'

const glab = vi.hoisted(() => ({
  resolveReviewSourceProject: vi.fn(async ({ urls }: { repoPath: string; urls: string[] }) => {
    const fork = urls[0]?.includes('/fork/') === true
    return {
      id: fork ? 2 : 1,
      project: { host: 'gitlab.example', path: fork ? 'fork/app' : 'acme/app' }
    }
  })
}))

// Only glab/network seams are faked; the review source comes from real Git in real worktrees.
vi.mock('../projects/gitlab-known-host-probe', () => ({
  getGlabKnownHosts: async () => ['gitlab.example']
}))
vi.mock('../projects/gitlab-project-ref-resolution', () => ({
  getProjectRef: async () => ({ host: 'gitlab.example', path: 'acme/app' }),
  glabHostnameArgs: () => [],
  glabRepoExecOptions: () => ({})
}))
vi.mock('../requests/glab-request-admission', () => ({
  acquire: async () => {},
  release: () => {}
}))
vi.mock('./branch-review-source', () => ({
  resolveReviewSourceProject: glab.resolveReviewSourceProject
}))
vi.mock('./branch-review-discovery', () => ({
  createGitLabBranchDiscovery: () => async () => null
}))
vi.mock('../../source-control/repo-default-branch', () => ({
  getRepoDefaultBranchName: async () => 'main',
  getRemoteHeadBranchName: async () => 'main',
  shouldHideNonOpenReviewOnDefaultBranch: async () => false
}))

import {
  trackedUpstreamSnapshotCache,
  trackedUpstreamSnapshotGenerations,
  trackedUpstreamSnapshotInFlight
} from '../../github/client/lookup/tracked-upstream-cache'
import { getMergeRequestForBranch } from './merge-request-lookup'

const roots: string[] = []
const savedEnv = {
  global: process.env.GIT_CONFIG_GLOBAL,
  nosystem: process.env.GIT_CONFIG_NOSYSTEM
}
let fixture: LinkedWorktreeFixture

function sourceUrlsFor(repoPath: string): string[][] {
  return glab.resolveReviewSourceProject.mock.calls
    .filter(([args]) => args.repoPath === repoPath)
    .map(([args]) => args.urls)
}

beforeEach(async () => {
  trackedUpstreamSnapshotCache.clear()
  trackedUpstreamSnapshotInFlight.clear()
  trackedUpstreamSnapshotGenerations.clear()
  glab.resolveReviewSourceProject.mockClear()
  fixture = await createLinkedWorktreeFixture(roots)
})

afterEach(async () => {
  restoreGitConfigEnv(savedEnv)
  await removeTempDirs(roots.splice(0))
})

describe('GitLab MR lookup source in linked worktrees', () => {
  it('uses each worktree’s own review source, concurrently', async () => {
    const { repoPath, worktreePath } = fixture
    await expect(
      Promise.all([
        getMergeRequestForBranch(worktreePath, 'feature'),
        getMergeRequestForBranch(repoPath, 'feature')
      ])
    ).resolves.toEqual([null, null])
    expect(sourceUrlsFor(worktreePath)[0]).toEqual([FORK_URL])
    expect(sourceUrlsFor(repoPath)).toEqual([[ORIGIN_URL]])
  })

  it('re-reads the review source on user refresh', async () => {
    const { worktreePath, globalConfigPath } = fixture
    await getMergeRequestForBranch(worktreePath, 'feature')
    await writeFile(globalConfigPath, '[branch "feature"]\n\tpushRemote = origin\n')
    glab.resolveReviewSourceProject.mockClear()

    await getMergeRequestForBranch(worktreePath, 'feature')
    expect(sourceUrlsFor(worktreePath)[0]).toEqual([FORK_URL])
    glab.resolveReviewSourceProject.mockClear()
    await getMergeRequestForBranch(worktreePath, 'feature', null, null, { userRefresh: true })
    expect(sourceUrlsFor(worktreePath)[0]).toEqual([ORIGIN_URL])
  })
})
