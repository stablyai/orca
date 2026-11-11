import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { mapMRInfo } from '../requests/gitlab-response-mapping'
import { __resetHostedReviewBranchCacheForTests } from '../../source-control/hosted-review-branch-cache'

const {
  glabExecFileAsyncMock,
  glabApiWithHeadersMock,
  getGlabKnownHostsMock,
  getProjectRefMock,
  resolveIssueSourceMock,
  acquireMock,
  releaseMock,
  gitExecFileAsyncMock,
  reviewSourceMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  glabApiWithHeadersMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  getProjectRefMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  reviewSourceMock: vi.fn()
}))

// Why: the #9171 default-branch guard resolves the repo default branch via
// git; keep those probes hermetic instead of spawning real git processes.
vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../../github/client/lookup/tracked-upstream-branch', () => ({
  getReviewBranchSource: reviewSourceMock
}))
vi.mock('./branch-review-source', () => ({
  resolveReviewSourceProject: async () => ({ id: 1, project: { host: 'gitlab.com', path: 'g/p' } })
}))

vi.mock('../../git/command-runner/glab-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('../requests/glab-request-admission', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabApiWithHeaders: glabApiWithHeadersMock,
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../projects/gitlab-known-host-probe', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGlabKnownHosts: getGlabKnownHostsMock
}))

vi.mock('../projects/gitlab-project-ref-resolution', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectRef: getProjectRefMock
}))

vi.mock('../issues/gitlab-issue-source-resolution', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIssueSource: resolveIssueSourceMock
}))
import { getMergeRequestForBranch } from './merge-request-lookup'
import '../../source-control/forge-review-mappers'
import { resetGitLabMrMocks } from './client-mr-test-harness'
import { resetMergedMRCommitMembershipForTest } from './merged-mr-commit-membership'

type MergeRequestDetail = Parameters<typeof mapMRInfo>[0]

function mockBranchLookup(mr: MergeRequestDetail): void {
  const identity = {
    source_project_id: 1,
    target_project_id: 1,
    source_branch: 'main',
    updated_at: '2026-11-01T00:00:00Z'
  }
  glabExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: JSON.stringify([{ ...identity, ...mr }]) })
    .mockResolvedValueOnce({ stdout: JSON.stringify({ ...identity, ...mr }) })
}

describe('gitlab client — MR operations', () => {
  afterEach(() => {
    vi.useRealTimers()
    __resetHostedReviewBranchCacheForTests()
  })

  beforeEach(() => {
    resetMergedMRCommitMembershipForTest()
    reviewSourceMock.mockReset().mockImplementation(async (_repo: string, branch: string) => ({
      remoteName: 'origin',
      urls: ['https://gitlab.com/g/p.git'],
      branchName: branch
    }))
    resetGitLabMrMocks({
      glabExecFileAsyncMock,
      glabApiWithHeadersMock,
      getGlabKnownHostsMock,
      getProjectRefMock,
      resolveIssueSourceMock,
      acquireMock,
      releaseMock,
      gitExecFileAsyncMock
    })
  })

  describe('getMergeRequestForBranch', () => {
    // List endpoints require explicit asynchronous recheck before merge status can converge.

    it('hides a stale closed MR whose source branch is the repo default branch (#9171)', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      mockBranchLookup({
        iid: 7,
        title: 'Accidental MR from main',
        state: 'closed',
        sha: 'stale-main-oid',
        head_pipeline: { status: 'success' }
      })

      await expect(getMergeRequestForBranch('/repo', 'main')).resolves.toBeNull()
    })

    it('hides a stuck-locked MR whose source branch is the repo default branch (#9171)', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      mockBranchLookup({
        iid: 9,
        title: 'Wedged mid-merge MR from main',
        state: 'locked',
        sha: 'locked-main-oid',
        head_pipeline: { status: 'success' }
      })

      await expect(getMergeRequestForBranch('/repo', 'main')).resolves.toBeNull()
    })
  })
})
