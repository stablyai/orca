import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const { PROJECT_ID } = vi.hoisted(() => ({ PROJECT_ID: 42 }))

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
vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./gitlab-project-id', () => ({ getGitLabProjectId: vi.fn(async () => PROJECT_ID) }))

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

import {
  getMergeRequest,
  getMergeRequestForBranch,
  getMergeRequestForBranchOrThrow
} from './client'
import { primeGitConfig, resetGitLabMrMocks } from './client-mr-test-harness'

describe('gitlab client — MR operations', () => {
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

  it('getMergeRequestForBranchOrThrow surfaces a glab failure instead of null (finding 4)', async () => {
    getProjectRefMock.mockResolvedValue({ host: 'gitlab.com', path: 'g/p' })
    glabExecFileAsyncMock.mockRejectedValue(new Error('glab: connection refused'))

    // The swallowing variant collapses a real failure into a false "no MR".
    await expect(getMergeRequestForBranch('/repo', 'feature/x')).resolves.toBeNull()
    // The throwing variant makes the failure visible so eligibility records
    // `unavailable` rather than a false "No merge request found".
    await expect(getMergeRequestForBranchOrThrow('/repo', 'feature/x')).rejects.toThrow(
      /connection refused/
    )
  })

  describe('getMergeRequest', () => {
    it('fetches the MR with rolled-up pipeline status', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 10,
          title: 'Add feature',
          state: 'opened',
          web_url: 'https://gitlab.com/g/p/-/merge_requests/10',
          updated_at: '2026-05-05T00:00:00Z',
          sha: 'deadbeef',
          head_pipeline: { status: 'success' },
          detailed_merge_status: 'mergeable'
        })
      })
      const mr = await getMergeRequest('/repo', 10)
      expect(mr).toMatchObject({
        number: 10,
        title: 'Add feature',
        state: 'opened',
        url: 'https://gitlab.com/g/p/-/merge_requests/10',
        pipelineStatus: 'success',
        mergeable: 'MERGEABLE',
        headSha: 'deadbeef'
      })
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/10'],
        { cwd: '/repo' }
      )
    })

    it('falls back to `glab mr view` when project ref is unresolved', async () => {
      getProjectRefMock.mockResolvedValueOnce(null)
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ iid: 5, title: 't', state: 'opened' })
      })
      await getMergeRequest('/repo', 5)
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['mr', 'view', '5', '--output', 'json'], {
        cwd: '/repo'
      })
    })

    it('returns null when glab errors', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('not found'))
      await expect(getMergeRequest('/repo', 99)).resolves.toBeNull()
    })

    it('treats neutral pipeline (no head_pipeline) as neutral status', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 1,
          title: 't',
          state: 'opened',
          head_pipeline: null
        })
      })
      const mr = await getMergeRequest('/repo', 1)
      expect(mr?.pipelineStatus).toBe('neutral')
    })
  })

  describe('getMergeRequestForBranch', () => {
    it('finds the most recently updated MR for a branch across states', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 7,
            source_project_id: PROJECT_ID,
            title: 'WIP',
            state: 'merged',
            sha: 'abc',
            head_pipeline: { status: 'success' }
          }
        ])
      })

      const mr = await getMergeRequestForBranch('/repo', 'feature/foo')
      expect(mr?.number).toBe(7)
      expect(mr?.state).toBe('merged')
      expect(mr?.pipelineStatus).toBe('success')
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'api',
          'projects/g%2Fp/merge_requests?source_project_id=42&source_branch=feature%2Ffoo&order_by=updated_at&sort=desc&per_page=10&with_merge_status_recheck=true'
        ],
        { cwd: '/repo' }
      )
    })

    // Why: GitLab does not proactively recompute merge status on list endpoints, so without the
    // recheck request the row can sit at `unchecked` forever and the sidebar merge button — which
    // gates on MERGEABLE — never becomes available.
    it('asks GitLab to recheck merge status on the branch lookup', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

      await getMergeRequestForBranch('/repo', 'feature/recheck')
      const callArgs = glabExecFileAsyncMock.mock.calls[0][0] as string[]
      expect(callArgs[1]).toContain('with_merge_status_recheck=true')
    })

    it('uses legacy pipeline payloads when branch MR lists omit head_pipeline', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 8,
            source_project_id: PROJECT_ID,
            title: 'Legacy pipeline branch',
            state: 'opened',
            sha: 'def',
            pipeline: { status: 'failed' }
          }
        ])
      })

      const mr = await getMergeRequestForBranch('/repo', 'feature/legacy-pipeline')
      expect(mr?.number).toBe(8)
      expect(mr?.pipelineStatus).toBe('failure')
    })

    it('strips refs/heads/ prefix from the branch arg', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

      await getMergeRequestForBranch('/repo', 'refs/heads/feature/bar')
      const callArgs = glabExecFileAsyncMock.mock.calls[0][0] as string[]
      expect(callArgs[1]).toContain('source_branch=feature%2Fbar')
    })

    it('returns null when no MR matches the branch', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })
      await expect(getMergeRequestForBranch('/repo', 'feature')).resolves.toBeNull()
    })

    it('resolves a linked MR by iid without querying the branch', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 9,
          source_project_id: PROJECT_ID,
          title: 'Linked MR',
          state: 'opened',
          pipeline: { status: 'success' }
        })
      })

      const mr = await getMergeRequestForBranch('/repo', 'local-review-branch', 9)
      expect(mr?.number).toBe(9)
      expect(mr?.pipelineStatus).toBe('success')
      expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/9?with_merge_status_recheck=true'],
        { cwd: '/repo' }
      )
    })

    it('uses the explicitly linked MR when the branch still matches a different MR', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 2,
          source_project_id: PROJECT_ID,
          title: 'Replacement linked MR',
          state: 'opened',
          sha: 'head-2',
          head_pipeline: { status: 'pending' }
        })
      })

      const mr = await getMergeRequestForBranch('/repo', 'qa/real-mr', 2)

      expect(mr).toMatchObject({
        number: 2,
        title: 'Replacement linked MR',
        pipelineStatus: 'pending'
      })
      expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/2?with_merge_status_recheck=true'],
        { cwd: '/repo' }
      )
    })

    it('uses one exact lookup when the linked MR also matches the branch', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 2,
          source_project_id: PROJECT_ID,
          title: 'Already selected MR',
          state: 'opened',
          sha: 'head-2',
          head_pipeline: { status: 'success' }
        })
      })

      await expect(
        getMergeRequestForBranch('/repo', 'qa/replacement-mr', 2)
      ).resolves.toMatchObject({ number: 2 })
      expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/2?with_merge_status_recheck=true'],
        { cwd: '/repo' }
      )
    })

    it('preserves merged state when resolving a linked MR iid', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 10,
          source_project_id: PROJECT_ID,
          title: 'Merged linked MR',
          state: 'merged',
          pipeline: { status: 'success' }
        })
      })

      const mr = await getMergeRequestForBranch('/repo', 'local-review-branch', 10)

      expect(mr).toMatchObject({
        number: 10,
        state: 'merged',
        pipelineStatus: 'success'
      })
    })

    it('routes local WSL merge-request branch lookup through the selected distro', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 12,
            source_project_id: PROJECT_ID,
            title: 'WSL branch',
            state: 'opened',
            sha: 'abc',
            head_pipeline: { status: 'success' }
          }
        ])
      })

      const mr = await getMergeRequestForBranch('/repo', 'feature/wsl', null, null, {
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })

      expect(mr?.number).toBe(12)
      expect(getProjectRefMock).toHaveBeenCalledWith('/repo', ['gitlab.com'], null, {
        wslDistro: 'Ubuntu'
      })
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(expect.any(Array), {
        cwd: '/repo',
        wslDistro: 'Ubuntu'
      })
    })

    it('hides a stale closed MR whose source branch is the repo default branch (#9171)', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 7,
            source_project_id: PROJECT_ID,
            title: 'Accidental MR from main',
            state: 'closed',
            sha: 'stale-main-oid',
            head_pipeline: { status: 'success' }
          }
        ])
      })

      await expect(getMergeRequestForBranch('/repo', 'main')).resolves.toBeNull()
    })

    it('hides a stuck-locked MR whose source branch is the repo default branch (#9171)', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 9,
            source_project_id: PROJECT_ID,
            title: 'Wedged mid-merge MR from main',
            state: 'locked',
            sha: 'locked-main-oid',
            head_pipeline: { status: 'success' }
          }
        ])
      })

      await expect(getMergeRequestForBranch('/repo', 'main')).resolves.toBeNull()
    })

    it('keeps an open MR whose source branch is the repo default branch', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 8,
            source_project_id: PROJECT_ID,
            title: 'main → release',
            state: 'opened',
            sha: 'abc',
            head_pipeline: { status: 'success' }
          }
        ])
      })

      const mr = await getMergeRequestForBranch('/repo', 'main')
      expect(mr?.number).toBe(8)
      // Open results never consult git for the default branch (lazy resolution); the
      // review-head config read is the only git call.
      expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args[0])).toEqual(['config'])
    })

    it('keeps a closed MR on a feature branch (behavior preserved)', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 9,
            source_project_id: PROJECT_ID,
            title: 'Rejected work',
            state: 'closed',
            sha: 'def',
            head_pipeline: { status: 'failed' }
          }
        ])
      })

      const mr = await getMergeRequestForBranch('/repo', 'feature/rejected')
      expect(mr?.number).toBe(9)
      expect(mr?.state).toBe('closed')
    })

    it('resolves a linked default-branch MR without consulting a branch shadow (#9171)', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 42,
          source_project_id: PROJECT_ID,
          title: 'Linked MR',
          state: 'merged',
          pipeline: { status: 'success' }
        })
      })

      const mr = await getMergeRequestForBranch('/repo', 'main', 42)

      expect(mr).toMatchObject({ number: 42, state: 'merged' })
      expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/42?with_merge_status_recheck=true'],
        { cwd: '/repo' }
      )
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    })

    it('keeps a linked non-open MR on the default branch', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 7,
          source_project_id: PROJECT_ID,
          title: 'Linked trunk MR',
          state: 'merged',
          sha: 'abc',
          head_pipeline: { status: 'success' }
        })
      })

      const mr = await getMergeRequestForBranch('/repo', 'main', 7)

      expect(mr).toMatchObject({ number: 7, state: 'merged' })
      expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
    })

    it('shows the open MR over a newer closed one from the same branch (#28324)', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { iid: 9, source_project_id: PROJECT_ID, title: 'Retry', state: 'closed' },
          { iid: 3, source_project_id: PROJECT_ID, title: 'Feature', state: 'opened' }
        ])
      })

      await expect(getMergeRequestForBranch('/repo', 'feature/foo')).resolves.toMatchObject({
        number: 3,
        state: 'opened'
      })
    })

    it('asks for open MRs only when a full page of closed ones could hide one', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      const closed = Array.from({ length: 10 }, (_, index) => ({
        iid: 20 + index,
        source_project_id: PROJECT_ID,
        title: 'Retry',
        state: 'closed'
      }))
      glabExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: JSON.stringify(closed) })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            { iid: 3, source_project_id: PROJECT_ID, title: 'Feature', state: 'opened' }
          ])
        })

      await expect(getMergeRequestForBranch('/repo', 'feature/foo')).resolves.toMatchObject({
        number: 3
      })
      expect(glabExecFileAsyncMock.mock.calls[1][0][1]).toContain(
        'source_branch=feature%2Ffoo&state=opened&'
      )
    })

    it('ignores a same-named branch from another project', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { iid: 5, source_project_id: PROJECT_ID + 1, title: 'Fork MR', state: 'opened' }
        ])
      })

      await expect(getMergeRequestForBranch('/repo', 'feature/foo')).resolves.toBeNull()
    })

    it('follows a `glab mr checkout` branch to its MR', async () => {
      primeGitConfig(gitExecFileAsyncMock, [
        ['branch.mr-9.remote', 'origin'],
        ['branch.mr-9.merge', 'refs/merge-requests/9/head']
      ])
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ iid: 9, source_project_id: 77, title: 'Fork MR', state: 'opened' })
      })

      await expect(getMergeRequestForBranch('/repo', 'mr-9')).resolves.toMatchObject({ number: 9 })
      expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/9?with_merge_status_recheck=true'],
        { cwd: '/repo' }
      )
    })

    it('returns null for an empty / detached-HEAD branch arg', async () => {
      // Why: during a rebase the branch is empty — mirror github/getPRForBranch's
      // early return without calling glab.
      await expect(getMergeRequestForBranch('/repo', '')).resolves.toBeNull()
      expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    })

    it('returns null when project ref cannot be resolved', async () => {
      getProjectRefMock.mockResolvedValueOnce(null)
      await expect(getMergeRequestForBranch('/repo', 'feature')).resolves.toBeNull()
      expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    })
  })
})
