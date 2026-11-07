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
  gitExecFileAsyncMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  glabApiWithHeadersMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  getProjectRefMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn()
}))

// Why: the #9171 default-branch guard resolves the repo default branch via
// git; keep those probes hermetic instead of spawning real git processes.
vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
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

type MergeRequestDetail = Parameters<typeof mapMRInfo>[0]

function mockBranchLookup(mr: MergeRequestDetail): void {
  glabExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: JSON.stringify([mr]) })
    .mockResolvedValueOnce({ stdout: JSON.stringify(mr) })
}

describe('gitlab client — MR operations', () => {
  afterEach(() => {
    vi.useRealTimers()
    __resetHostedReviewBranchCacheForTests()
  })

  beforeEach(() => {
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
            stdout: JSON.stringify([{ iid: 6, title: 'Flaky', state: 'opened' }])
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
