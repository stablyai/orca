import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'
import type { mapMRInfo } from './mappers'
import { __resetHostedReviewBranchCacheForTests } from '../source-control/hosted-review-branch-cache'

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
vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../github/client/lookup/tracked-upstream-branch', () => ({
  getReviewBranchSource: reviewSourceMock
}))
vi.mock('./branch-review-source', () => ({
  resolveReviewSourceProject: async () => ({ id: 1, project: { host: 'gitlab.com', path: 'g/p' } })
}))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    glabExecFileAsync: glabExecFileAsyncMock,
    glabApiWithHeaders: glabApiWithHeadersMock,
    getGlabKnownHosts: getGlabKnownHostsMock,
    getProjectRef: getProjectRefMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock
  }
})
import { getMergeRequestForBranch, getMergeRequestForBranchOrThrow } from './client'
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

    it.each([{}, { head_pipeline: null }, { head_pipeline: { status: 'success' } }])(
      'reads the failed head pipeline from detail instead of the branch list: %j',
      async (pipelineFields) => {
        const detail = {
          source_project_id: 1,
          target_project_id: 1,
          source_branch: 'feature/pipeline',
          updated_at: '2026-11-01T00:00:00Z',
          iid: 5049,
          title: 'Pipeline regression',
          state: 'opened',
          sha: 'abc',
          head_pipeline: { status: 'failed' }
        }
        getProjectRefMock.mockResolvedValue({ host: 'gitlab.com', path: 'g/p' })
        glabExecFileAsyncMock
          .mockResolvedValueOnce({
            stdout: JSON.stringify([{ ...detail, head_pipeline: undefined, ...pipelineFields }])
          })
          .mockResolvedValueOnce({ stdout: JSON.stringify(detail) })
          .mockResolvedValueOnce({ stdout: JSON.stringify(detail) })

        const discovered = await getMergeRequestForBranch('/repo', 'feature/pipeline')
        const linked = await getMergeRequestForBranch('/repo', 'feature/pipeline', 5049)
        expect(discovered).toEqual(linked)
        expect(discovered).toMatchObject({ number: 5049, pipelineStatus: 'failure' })
        expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(3)
        expect(glabExecFileAsyncMock.mock.calls[1]).toEqual(glabExecFileAsyncMock.mock.calls[2])
      }
    )

    it('preserves detail failures for strict callers instead of returning a neutral list row', async () => {
      getProjectRefMock.mockResolvedValue({ host: 'gitlab.com', path: 'g/p' })
      for (const lookup of [getMergeRequestForBranch, getMergeRequestForBranchOrThrow]) {
        glabExecFileAsyncMock
          .mockResolvedValueOnce({
            stdout: JSON.stringify([
              {
                iid: 6,
                title: 'Flaky',
                state: 'opened',
                source_project_id: 1,
                target_project_id: 1,
                source_branch: 'flaky',
                updated_at: '2026-11-01T00:00:00Z'
              }
            ])
          })
          .mockRejectedValueOnce(new Error('glab: 502'))
        const result = lookup('/repo', 'flaky')
        await (lookup === getMergeRequestForBranchOrThrow
          ? expect(result).rejects.toThrow('glab: 502')
          : expect(result).resolves.toBeNull())
      }
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('glab: 502'))
      await expect(getMergeRequestForBranchOrThrow('/repo', 'flaky', 6)).rejects.toThrow(
        'glab: 502'
      )
      expect(glabExecFileAsyncMock.mock.calls[4]).toEqual(glabExecFileAsyncMock.mock.calls[3])
      expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(5)
      expect(releaseMock).toHaveBeenCalledTimes(3)
    })

    it('uses a qualified tracked name only after complete local absence and excludes the default branch', async () => {
      getProjectRefMock.mockResolvedValue({ host: 'gitlab.com', path: 'g/p' })
      reviewSourceMock.mockResolvedValue({
        remoteName: 'origin',
        urls: ['https://gitlab.com/g/p.git'],
        branchName: 'wip',
        trackedBranchName: 'renamed',
        trackedUrls: ['https://gitlab.com/g/p.git']
      })
      const mr = {
        iid: 8,
        title: 'Renamed',
        state: 'opened',
        source_project_id: 1,
        target_project_id: 1,
        source_branch: 'renamed',
        updated_at: '2026-11-01T00:00:00Z'
      }
      glabExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: '[]' })
        .mockResolvedValueOnce({ stdout: JSON.stringify([mr]) })
        .mockResolvedValueOnce({ stdout: JSON.stringify(mr) })
      await expect(getMergeRequestForBranchOrThrow('/repo', 'wip')).resolves.toMatchObject({
        number: 8
      })
      expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(3)
      reviewSourceMock.mockResolvedValue({
        remoteName: 'origin',
        urls: ['https://gitlab.com/g/p.git'],
        branchName: 'wip',
        trackedBranchName: 'main',
        trackedUrls: ['https://gitlab.com/g/p.git']
      })
      glabExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: '[]' })
        .mockResolvedValueOnce({ stdout: JSON.stringify([{ ...mr, source_branch: 'main' }]) })
      await expect(getMergeRequestForBranchOrThrow('/repo', 'wip')).resolves.toBeNull()
      expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(5)
    })

    it.each([10, 100])(
      'walks immutable membership once across %s admitted provider refreshes',
      async (count) => {
        getProjectRefMock.mockResolvedValue({ host: 'gitlab.com', path: 'g/p' })
        const head = 'f'.repeat(40)
        const mr = {
          iid: 8,
          title: 'Merged',
          state: 'merged',
          sha: 'a'.repeat(40),
          source_project_id: 1,
          target_project_id: 1,
          source_branch: 'feature',
          updated_at: '2026-11-01T00:00:00Z'
        }
        glabExecFileAsyncMock.mockImplementation(async (args: string[]) => ({
          stdout:
            args.at(-1) === 'user'
              ? '{"id":1}'
              : JSON.stringify(args.at(-1)?.includes('source_branch=') ? [mr] : mr)
        }))
        glabApiWithHeadersMock.mockImplementation(async (args: string[]) => {
          const page = Number(
            new URL(args.at(-1) ?? '', 'https://gitlab.com').searchParams.get('page')
          )
          return {
            body: JSON.stringify(
              Array.from({ length: 100 }, (_, i) => ({
                id: page === 5 && i === 99 ? head : (page * 100 + i).toString(16).padStart(40, '0')
              }))
            ),
            headers: { 'x-next-page': page < 5 ? String(page + 1) : '' }
          }
        })
        for (let i = 0; i < count; i++) {
          await expect(
            getMergeRequestForBranchOrThrow('/repo', 'feature', null, null, {
              currentHeadOid: head
            })
          ).resolves.toMatchObject({ number: 8 })
        }
        expect(glabApiWithHeadersMock).toHaveBeenCalledTimes(5)
        expect(
          glabExecFileAsyncMock.mock.calls.filter(([args]) => args.at(-1) === 'user')
        ).toHaveLength(count)
        expect(
          glabExecFileAsyncMock.mock.calls.filter(([args]) =>
            args.at(-1)?.includes('source_branch=')
          )
        ).toHaveLength(count)
        expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(count * 3)
      }
    )

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
